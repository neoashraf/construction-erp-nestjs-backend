/**
 * OFFICE capture through the punch pipeline, against real Postgres (FR-HR-004; design §4.1, §2.6).
 *
 * `attendance_record` used to have TWO independent writers with contradictory rules: `capture()`
 * inserted a row directly and REJECTED a second row for the same employee-day, while `reconcileDays`
 * upserted and MERGED — and its UPDATE overwrote `check_in`/`check_out` on a row that had been keyed
 * in by hand. So a hand-keyed roster was silently overwritten by the next device punch, and an
 * operator correcting a day got `DuplicateAttendanceError` instead.
 *
 * Now reconciliation is the ONLY writer of times and all four ingestion paths converge on it. Every
 * property that convergence is supposed to buy is asserted here rather than in a unit test, because
 * each one is enforced by a database object — the `(company, user, device_timestamp)` punch key, the
 * `uq_attendance_office_employee_day` partial-unique index, and the upsert that patches only the
 * day-level fields. A mocked repository would report green on all of them regardless.
 *
 * This spec touches NO ledger code: no `journal_entry`, no `PostingService`, no accrual.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateHrEmployeeAttendance1700001300000 } from '../src/database/migrations/1700001300000-CreateHrEmployeeAttendance';
import { CreateAttendanceReportConfig1784700000000 } from '../src/database/migrations/1784700000000-CreateAttendanceReportConfig';
import { CreateCheckinLog1784800000000 } from '../src/database/migrations/1784800000000-CreateCheckinLog';
import { AddCheckinLogProject1784900000000 } from '../src/database/migrations/1784900000000-AddCheckinLogProject';

import { TypeOrmAttendanceRepository } from '../src/modules/hr/infrastructure/typeorm-attendance.repository';
import { TypeOrmPunchIngestionRepository } from '../src/modules/hr/attendance-reports/infrastructure/typeorm-punch-ingestion.repository';
import { AttendanceService } from '../src/modules/hr/application/attendance.service';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { Actor } from '../src/core/tenancy/tenant-context';
import type { NewAttendance } from '../src/modules/hr/domain/attendance-record';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-00000000c001';
const FY = '00000000-0000-0000-0000-00000000f001';
const PARTY = '00000000-0000-0000-0000-00000000aa01';
const PM = '00000000-0000-0000-0000-00000000ee01';
const PROJECT_A = '00000000-0000-0000-0000-00000000a001';
const EMP = '00000000-0000-0000-0000-00000000e009';
/** The device enrolment code. Punches key on this, never the employee UUID. */
const CODE = 'E100';

const actor: Actor = {
  userId: '00000000-0000-0000-0000-00000000ee01',
  companyId: CO,
  financialYearId: FY,
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

function officeRow(overrides: Partial<NewAttendance>): NewAttendance {
  return {
    mode: 'OFFICE',
    employeeId: EMP,
    attendanceDate: '2026-07-12',
    projectId: PROJECT_A,
    checkIn: null,
    checkOut: null,
    dayStatus: 'PRESENT',
    overtimeHours: '0',
    ...overrides,
  } as NewAttendance;
}

describe('OFFICE capture merges through the punch pipeline (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let service: AttendanceService;
  let punches: TypeOrmPunchIngestionRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    ds = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      synchronize: false,
      entities: [],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateLedger1700000400000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
        CreateHrEmployeeAttendance1700001300000,
        CreateAttendanceReportConfig1784700000000,
        CreateCheckinLog1784800000000,
        AddCheckinLogProject1784900000000,
      ],
    });
    await ds.initialize();
    await ds.runMigrations();

    await ds.query(
      `INSERT INTO "company" ("id","name","legal_name","bin","tin")
       VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`,
      [CO],
    );
    await ds.query(
      `INSERT INTO "financial_year" ("id","company_id","label","start_date","end_date","is_active")
       VALUES ($1,$2,'2026-27','2026-07-01','2027-06-30',true)`,
      [FY, CO],
    );
    await ds.query(
      `INSERT INTO "party" ("id","company_id","name","is_customer","is_supplier","phone")
       VALUES ($1,$2,'Client A',true,false,'+8801700000000')`,
      [PARTY, CO],
    );
    await ds.query(
      `INSERT INTO "project"
              ("id","company_id","project_code","name","customer_id","project_manager_id",
               "start_date","expected_end_date","status")
       VALUES ($1,$2,'HO-OVH','Head Office — Overhead',$3,$4,'2026-07-01','2027-06-30','ACTIVE')`,
      [PROJECT_A, CO, PARTY, PM],
    );
    await ds.query(
      `INSERT INTO "employee"
              ("id","company_id","employee_code","name","designation","default_project_id",
               "work_base","wage_type","wage_amount","joining_date")
       VALUES ($1,$2,$3,'Karim Rahman','Officer',$4,'HEAD_OFFICE','MONTHLY',40000,'2025-01-01')`,
      [EMP, CO, CODE, PROJECT_A],
    );

    const ids = new UuidIdGenerator();
    const uow = new TypeOrmUnitOfWork(ds);
    punches = new TypeOrmPunchIngestionRepository(ds, ids);
    service = new AttendanceService(
      new TypeOrmAttendanceRepository(ds, ids),
      {} as never, // payables — daily-labour only, never reached by OFFICE capture
      {} as never, // account resolver
      {} as never, // project status
      { post: () => Promise.reject(new Error('OFFICE capture must never post')) } as never,
      punches,
      { record: async () => undefined } as never,
      uow,
      ids,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM "attendance_record" WHERE "company_id" = $1`, [CO]);
    await ds.query(`DELETE FROM "checkin_log" WHERE "company_id" = $1`, [CO]);
  });

  it('merges a hand-keyed roster with a later device punch instead of overwriting it', async () => {
    await service.capture(
      'OFFICE',
      [officeRow({ attendanceDate: '2026-07-12', checkIn: '09:05', checkOut: '13:00' })],
      actor,
    );

    // The device later reports an 18:10 exit for the same day.
    await punches.insertPunches(CO, [
      {
        sourceType: 'DEVICE_SYNC',
        userId: CODE,
        deviceTimestamp: '2026-07-12 18:10:00',
        status: '1',
        occurredAt: new Date('2026-07-12T18:10:00'),
        deviceSn: null,
        projectId: null,
      },
    ]);
    await punches.reconcileDays(CO, null, [{ userId: CODE, attendanceDate: '2026-07-12' }]);

    const rows = await ds.query(
      `SELECT "check_in"::text AS "checkIn", "check_out"::text AS "checkOut",
              "day_status" AS "dayStatus"
         FROM "attendance_record"
        WHERE "company_id" = $1 AND "attendance_date" = '2026-07-12' AND "mode" = 'OFFICE'`,
      [CO],
    );

    expect(rows).toHaveLength(1); // still ONE row per employee-day
    expect(rows[0].checkIn).toBe('09:05:00'); // the manual check-in survived
    expect(rows[0].checkOut).toBe('18:10:00'); // the device check-out merged in
    expect(rows[0].dayStatus).toBe('PRESENT');
  });

  it('records a timeless PAID_LEAVE day as a row with no punches', async () => {
    // Without this branch a leave day produces NO row — and `paidDays` counts rows, so the
    // employee silently loses a day's pay.
    await service.capture(
      'OFFICE',
      [officeRow({ attendanceDate: '2026-07-13', dayStatus: 'PAID_LEAVE' })],
      actor,
    );

    const rows = await ds.query(
      `SELECT "day_status" AS "dayStatus", "check_in" AS "checkIn" FROM "attendance_record"
        WHERE "company_id" = $1 AND "attendance_date" = '2026-07-13' AND "mode" = 'OFFICE'`,
      [CO],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dayStatus).toBe('PAID_LEAVE');
    expect(rows[0].checkIn).toBeNull();

    const punchRows = await ds.query(
      `SELECT 1 FROM "checkin_log" WHERE "company_id" = $1
        AND substring("device_timestamp" from 1 for 10) = '2026-07-13'`,
      [CO],
    );
    expect(punchRows).toHaveLength(0); // a leave day is not a punch
  });

  it('re-submitting the same day is idempotent', async () => {
    const row = officeRow({ attendanceDate: '2026-07-14', checkIn: '09:00', checkOut: '18:00' });

    const first = await service.capture('OFFICE', [row], actor);
    const second = await service.capture('OFFICE', [row], actor); // must NOT throw

    const rows = await ds.query(
      `SELECT 1 FROM "attendance_record" WHERE "company_id" = $1
        AND "attendance_date" = '2026-07-14' AND "mode" = 'OFFICE'`,
      [CO],
    );
    expect(rows).toHaveLength(1);
    // The id is stable across resubmission — the day is unique per (company, employee, date).
    expect(second.ids).toEqual(first.ids);

    const punchRows = await ds.query(
      `SELECT count(*)::int AS c FROM "checkin_log" WHERE "company_id" = $1
        AND substring("device_timestamp" from 1 for 10) = '2026-07-14'`,
      [CO],
    );
    expect(punchRows[0].c).toBe(2); // two punches, not four
  });

  it('keeps an approved day status when the device punches the same day afterwards', async () => {
    await service.capture(
      'OFFICE',
      [officeRow({ attendanceDate: '2026-07-15', dayStatus: 'PAID_LEAVE' })],
      actor,
    );

    await punches.insertPunches(CO, [
      {
        sourceType: 'DEVICE_PUSH',
        userId: CODE,
        deviceTimestamp: '2026-07-15 09:02:00',
        status: '0',
        occurredAt: null,
        deviceSn: null,
        projectId: null,
      },
    ]);
    await punches.reconcileDays(CO, null, [{ userId: CODE, attendanceDate: '2026-07-15' }]);

    const [row] = await ds.query(
      `SELECT "day_status" AS "dayStatus", "check_in"::text AS "checkIn" FROM "attendance_record"
        WHERE "company_id" = $1 AND "attendance_date" = '2026-07-15' AND "mode" = 'OFFICE'`,
      [CO],
    );
    // Reconciliation sets day_status only on CREATE, so the approved leave survives while the
    // time still attaches — otherwise a stray punch would quietly cancel someone's leave.
    expect(row.dayStatus).toBe('PAID_LEAVE');
    expect(row.checkIn).toBe('09:02:00');
  });

  it('tags the day with the project the operator stated, not the employee default', async () => {
    await service.capture(
      'OFFICE',
      [officeRow({ attendanceDate: '2026-07-16', checkIn: '09:05' })],
      actor,
    );

    const [punchRow] = await ds.query(
      `SELECT "project_id"::text AS "projectId", "source_type" AS "sourceType"
         FROM "checkin_log" WHERE "company_id" = $1
          AND substring("device_timestamp" from 1 for 10) = '2026-07-16'`,
      [CO],
    );
    // Manual entry always states its location, so it is rank 1 of the resolution order — never
    // null-and-hope-the-device-default-covers-it, which would mis-tag a branch office.
    expect(punchRow.projectId).toBe(PROJECT_A);
    expect(punchRow.sourceType).toBe('MANUAL');
  });

  it('writes no journal entry — office capture is GL-free', async () => {
    await service.capture(
      'OFFICE',
      [officeRow({ attendanceDate: '2026-07-17', checkIn: '09:00', checkOut: '17:00' })],
      actor,
    );

    const [entries] = await ds.query(`SELECT count(*)::int AS c FROM "journal_entry"`);
    expect(entries.c).toBe(0);
  });
});
