/**
 * The attendance reports read ATTENDANCE TRUTH — against real Postgres (FR-HR-004, FR-HR-008a).
 *
 * `AttendanceReportReadAdapter` had no integration test at all: both existing specs drive the service
 * through a FAKE port, so the adapter's SQL — the thing this brief changes — was never executed. A
 * fake cannot catch a wrong join, a date that arrives as a `Date` instead of `YYYY-MM-DD`, or a
 * `time` column that stringifies differently than the contract expects, which is exactly the class of
 * bug a source change introduces.
 *
 * The two properties worth proving here:
 *   1. a day carrying a STATUS and no times renders as that status — the case punches cannot express,
 *      and the reason payroll and the report used to disagree over a day payroll pays;
 *   2. a window containing employee-days that reconciliation SKIPPED says so, instead of rendering
 *      them `Absent` and reading like a complete report. That is the standing guard against the
 *      27/07/2026 regression, and it is asserted with punches present and nothing reconciled —
 *      precisely the state that caused it.
 *
 * No ledger code is on this path: no `journal_entry`, no `PostingService`, no posting of any kind.
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

import { AttendanceReportReadAdapter } from '../src/modules/hr/attendance-reports/infrastructure/attendance-report.read.adapter';
import { AttendanceReportService } from '../src/modules/hr/attendance-reports/application/attendance-report.service';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-00000000c101';
const FY = '00000000-0000-0000-0000-00000000f101';
const PARTY = '00000000-0000-0000-0000-00000000aa11';
const PM = '00000000-0000-0000-0000-00000000ee11';
const PROJECT = '00000000-0000-0000-0000-00000000a101';
const EMP = '00000000-0000-0000-0000-00000000e101';
const CODE = '1042';

const actor = { companyId: CO, userId: PM } as Actor;

describe('attendance reports read attendance_record (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let service: AttendanceReportService;

  const day = (id: string, date: string, status: string, checkIn: string | null = null,
                checkOut: string | null = null) =>
    ds.query(
      `INSERT INTO "attendance_record"
              ("id","company_id","financial_year_id","mode","attendance_date","project_id",
               "employee_id","day_status","check_in","check_out")
       VALUES ($1,$2,$3,'OFFICE',$4::date,$5,$6,$7,$8::time,$9::time)`,
      [id, CO, FY, date, PROJECT, EMP, status, checkIn, checkOut],
    );

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
      [PROJECT, CO, PARTY, PM],
    );
    await ds.query(
      `INSERT INTO "employee"
              ("id","company_id","employee_code","name","designation","default_project_id",
               "work_base","wage_type","wage_amount","joining_date")
       VALUES ($1,$2,$3,'Karim Rahman','Officer',$4,'HEAD_OFFICE','MONTHLY',40000,'2025-01-01')`,
      [EMP, CO, CODE, PROJECT],
    );

    service = new AttendanceReportService(new AttendanceReportReadAdapter(ds));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM "attendance_record" WHERE "company_id" = $1`, [CO]);
    await ds.query(`DELETE FROM "checkin_log" WHERE "company_id" = $1`, [CO]);
  });

  it('renders a worked day from the stored times, deriving Present from the threshold', async () => {
    await day('00000000-0000-0000-0000-00000000d001', '2026-07-06', 'PRESENT', '09:05:00', '18:10:00');

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-06', dateTo: '2026-07-06' },
      actor,
    );
    const record = report.data[0]?.records[0];

    // The adapter composes the same 'YYYY-MM-DD HH:mm:ss' text the contract has always returned.
    expect(record?.checkInAt).toBe('2026-07-06 09:05:00');
    expect(record?.checkOutAt).toBe('2026-07-06 18:10:00');
    expect(record?.status).toBe('Present');
    expect(record?.punchCount).toBe(2);
  });

  it('renders a timeless PAID_LEAVE day as Paid leave, NOT as an absence', async () => {
    // Before this brief the same row rendered `Absent` — for a day payroll pays.
    await day('00000000-0000-0000-0000-00000000d002', '2026-07-07', 'PAID_LEAVE');

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-07', dateTo: '2026-07-07' },
      actor,
    );
    const row = report.data[0];

    expect(row?.records[0]?.status).toBe('Paid leave');
    expect(row?.records[0]?.checkInAt).toBeNull();
    expect(row?.absentCount).toBe(0);
    expect(row?.paidLeaveCount).toBe(1);
  });

  it('renders a timeless UNPAID_LEAVE day as Unpaid leave', async () => {
    await day('00000000-0000-0000-0000-00000000d003', '2026-07-08', 'UNPAID_LEAVE');

    const row = (
      await service.getRangeReport({ dateFrom: '2026-07-08', dateTo: '2026-07-08' }, actor)
    ).data[0];

    expect(row?.records[0]?.status).toBe('Unpaid leave');
    expect(row?.unpaidLeaveCount).toBe(1);
    expect(row?.absentCount).toBe(0);
  });

  it('derives Late from the stored check-in, and keeps 09:30:59 on time', async () => {
    await day('00000000-0000-0000-0000-00000000d004', '2026-07-09', 'PRESENT', '09:41:00');
    await day('00000000-0000-0000-0000-00000000d005', '2026-07-10', 'PRESENT', '09:30:59');

    const row = (
      await service.getRangeReport({ dateFrom: '2026-07-09', dateTo: '2026-07-10' }, actor)
    ).data[0];

    expect(row?.records[0]?.status).toBe('Late');
    expect(row?.records[1]?.status).toBe('Present'); // the threshold minute must fully elapse
    expect(row?.lateCount).toBe(1);
    expect(row?.presentCount).toBe(2); // late is a SUBSET of present
  });

  it('stays gap-free: a working day with no row at all is Absent', async () => {
    await day('00000000-0000-0000-0000-00000000d006', '2026-07-06', 'PRESENT', '09:00:00');

    const row = (
      await service.getRangeReport({ dateFrom: '2026-07-06', dateTo: '2026-07-08' }, actor)
    ).data[0];

    expect(row?.records).toHaveLength(3); // every date in the window yields a record
    expect(row?.records[1]?.status).toBe('Absent');
    expect(row?.absentCount).toBe(2);
  });

  it('reports a clean window as zero unreconciled days', async () => {
    await day('00000000-0000-0000-0000-00000000d007', '2026-07-06', 'PRESENT', '09:00:00');

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-06', dateTo: '2026-07-06' },
      actor,
    );

    expect(report.unreconciled).toEqual({ days: 0, reasons: {}, sample: [] });
  });

  it('THE 27/07 REGRESSION: punches present but nothing reconciled is REPORTED, not silently Absent', async () => {
    // The exact state that caused the original bug — raw punches with no day row to show for them.
    // The days still read Absent; what changed is that the report now says the data has holes.
    await ds.query(
      `INSERT INTO "checkin_log" ("id","company_id","source_type","user_id","device_timestamp","status")
       VALUES ($1,$2,'DEVICE_PUSH',$3,'2026-07-06 09:02:00','0')`,
      ['00000000-0000-0000-0000-00000000c901', CO, CODE],
    );

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-06', dateTo: '2026-07-06' },
      actor,
    );

    expect(report.unreconciled.days).toBe(1);
    // The employee EXISTS and a financial year covers the date, so the only remaining guard that
    // could have skipped this day is the project one.
    expect(report.unreconciled.reasons).toEqual({ NO_PROJECT: 1 });
    expect(report.unreconciled.sample[0]).toEqual({
      userId: CODE,
      attendanceDate: '2026-07-06',
      reason: 'NO_PROJECT',
    });
    expect(report.data[0]?.absentCount).toBe(1);
  });

  it('names an unknown enrolment code as UNKNOWN_EMPLOYEE_CODE, not as a missing project', async () => {
    await ds.query(
      `INSERT INTO "checkin_log" ("id","company_id","source_type","user_id","device_timestamp","status")
       VALUES ($1,$2,'DEVICE_PUSH','9999','2026-07-06 09:02:00','0')`,
      ['00000000-0000-0000-0000-00000000c902', CO],
    );

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-06', dateTo: '2026-07-06' },
      actor,
    );

    // Surfaced even though no employee row exists to attach it to — that is the case most worth
    // telling the operator about, and an employee-filtered query would drop it entirely.
    expect(report.unreconciled.reasons).toEqual({ UNKNOWN_EMPLOYEE_CODE: 1 });
  });

  it('names a date outside every financial year as NO_FINANCIAL_YEAR', async () => {
    await ds.query(
      `INSERT INTO "checkin_log" ("id","company_id","source_type","user_id","device_timestamp","status")
       VALUES ($1,$2,'DEVICE_PUSH',$3,'2030-01-06 09:02:00','0')`,
      ['00000000-0000-0000-0000-00000000c903', CO, CODE],
    );

    const report = await service.getRangeReport(
      { dateFrom: '2030-01-06', dateTo: '2030-01-06' },
      actor,
    );

    expect(report.unreconciled.reasons).toEqual({ NO_FINANCIAL_YEAR: 1 });
  });

  it('does NOT flag a day that reconciled successfully', async () => {
    // Punch AND a day row — reconciliation placed it, so there is nothing to warn about.
    await day('00000000-0000-0000-0000-00000000d008', '2026-07-06', 'PRESENT', '09:02:00');
    await ds.query(
      `INSERT INTO "checkin_log" ("id","company_id","source_type","user_id","device_timestamp","status")
       VALUES ($1,$2,'DEVICE_PUSH',$3,'2026-07-06 09:02:00','0')`,
      ['00000000-0000-0000-0000-00000000c904', CO, CODE],
    );

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-06', dateTo: '2026-07-06' },
      actor,
    );

    expect(report.unreconciled.days).toBe(0);
  });

  it('scopes every read by company (F3)', async () => {
    const other = '00000000-0000-0000-0000-00000000c199';
    await ds.query(
      `INSERT INTO "company" ("id","name","legal_name","bin","tin")
       VALUES ($1,'Other','Other Ltd','9999999999999','999999999999')
       ON CONFLICT ("id") DO NOTHING`,
      [other],
    );
    await day('00000000-0000-0000-0000-00000000d009', '2026-07-06', 'PRESENT', '09:00:00');

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-06', dateTo: '2026-07-06' },
      { companyId: other, userId: PM } as Actor,
    );

    expect(report.data).toHaveLength(0); // the other company sees none of this
  });

  it('writes no journal entry — the report path is read-only and GL-free', async () => {
    await day('00000000-0000-0000-0000-00000000d010', '2026-07-06', 'PRESENT', '09:00:00');
    await service.getRangeReport({ dateFrom: '2026-07-06', dateTo: '2026-07-06' }, actor);

    const [entries] = await ds.query(`SELECT count(*)::int AS c FROM "journal_entry"`);
    expect(entries.c).toBe(0);
  });
});
