/**
 * Punch ingestion against real Postgres — the ON CONFLICT counting contract.
 *
 * This exists because the bug it guards is INVISIBLE to a mocked repository. TypeORM's
 * `query()` resolves an INSERT to a bare `[]`, not the `[rows, rowCount]` tuple the pg driver
 * exposes, so the original `res[1] ?? 0` silently counted every insert as zero. Unit tests
 * stubbing `insertPunches` returned whatever they were told and reported green, while in
 * production a sync that stored hundreds of new punches said "0 new punches" — a working
 * feature that looked like a no-op.
 *
 * Only a real driver can prove the count, hence Testcontainers rather than a mock.
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

import { TypeOrmPunchIngestionRepository } from '../src/modules/hr/attendance-reports/infrastructure/typeorm-punch-ingestion.repository';
import type { PunchToStore } from '../src/modules/hr/attendance-reports/domain/ports/punch-ingestion.repository';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY = '00000000-0000-0000-0000-00000000f001';
const PARTY = '00000000-0000-0000-0000-00000000aa01';
const PM = '00000000-0000-0000-0000-00000000ee01';
/** The employee's standing default — the WEAKEST signal, and until now the one that won. */
const PROJECT_A = '00000000-0000-0000-0000-00000000a001';
/** The device's default — where the machine physically is. */
const PROJECT_B = '00000000-0000-0000-0000-00000000b002';
/** Stated on the punch itself — evidence, and therefore rank 1. */
const PROJECT_C = '00000000-0000-0000-0000-00000000c003';
const EMPLOYEE = '00000000-0000-0000-0000-00000000e009';

/** `company` has several NOT NULL columns with no default; all of them must be supplied. */
async function seedCompany(ds: DataSource, id: string, name: string): Promise<void> {
  await ds.query(
    `INSERT INTO "company" ("id", "name", "legal_name", "bin", "tin", "created_at", "updated_at")
     VALUES ($1, $2, $2, $3, $4, now(), now())
     ON CONFLICT ("id") DO NOTHING`,
    [id, name, `BIN-${id.slice(-4)}`, `TIN-${id.slice(-4)}`],
  );
}

function punch(
  userId: string,
  deviceTimestamp: string,
  projectId: string | null = null,
): PunchToStore {
  return {
    sourceType: 'EXCEL_IMPORT',
    userId,
    deviceTimestamp,
    status: '0',
    occurredAt: null,
    deviceSn: null,
    projectId,
  };
}

/**
 * The three candidate projects, one financial year and one employee whose default is PROJECT_A —
 * everything `reconcileDays` needs to place a day, so the only variable left is which project wins.
 */
async function seedResolutionFixtures(ds: DataSource): Promise<void> {
  await ds.query(
    `INSERT INTO "financial_year" ("id","company_id","label","start_date","end_date","is_active")
     VALUES ($1,$2,'2026-27','2026-07-01','2027-06-30',true) ON CONFLICT ("id") DO NOTHING`,
    [FY, CO],
  );
  await ds.query(
    `INSERT INTO "party" ("id","company_id","name","is_customer","is_supplier","phone")
     VALUES ($1,$2,'Client A',true,false,'+8801700000000') ON CONFLICT ("id") DO NOTHING`,
    [PARTY, CO],
  );
  const project = (id: string, code: string, name: string) =>
    ds.query(
      `INSERT INTO "project"
              ("id","company_id","project_code","name","customer_id","project_manager_id",
               "start_date","expected_end_date","status")
       VALUES ($1,$2,$3,$4,$5,$6,'2026-07-01','2027-06-30','ACTIVE') ON CONFLICT ("id") DO NOTHING`,
      [id, CO, code, name, PARTY, PM],
    );
  await project(PROJECT_A, 'P-A', 'Site A');
  await project(PROJECT_B, 'P-B', 'Head Office — Overhead');
  await project(PROJECT_C, 'P-C', 'Bridge-04');

  await ds.query(
    `INSERT INTO "employee"
            ("id","company_id","employee_code","name","designation","default_project_id",
             "work_base","wage_type","wage_amount","joining_date")
     VALUES ($1,$2,'E100','Karim Rahman','Engineer',$3,'SITE','MONTHLY',40000,'2025-01-01')
     ON CONFLICT ("id") DO NOTHING`,
    [EMPLOYEE, CO, PROJECT_A],
  );
}

describe('punch ingestion counting (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let repo: TypeOrmPunchIngestionRepository;

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

    await seedCompany(ds, CO, 'Probe Co');
    await seedResolutionFixtures(ds);

    repo = new TypeOrmPunchIngestionRepository(ds, new UuidIdGenerator());
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM "checkin_log" WHERE "company_id" = $1`, [CO]);
  });

  it('counts every genuinely new punch', async () => {
    const inserted = await repo.insertPunches(CO, [
      punch('1001', '2026-07-01 09:05:00'),
      punch('1001', '2026-07-01 18:10:00'),
      punch('1002', '2026-07-01 08:58:00'),
    ]);

    // The regression: this returned 0 while all three rows were really written.
    expect(inserted).toBe(3);

    const stored = await ds.query(
      `SELECT count(*)::int AS c FROM "checkin_log" WHERE "company_id" = $1`,
      [CO],
    );
    expect(stored[0].c).toBe(3);
  });

  it('counts a replayed batch as zero without writing anything', async () => {
    const batch = [punch('1001', '2026-07-01 09:05:00'), punch('1001', '2026-07-01 18:10:00')];

    expect(await repo.insertPunches(CO, batch)).toBe(2);
    // Idempotency: same punches, nothing new. This is what a re-import must report.
    expect(await repo.insertPunches(CO, batch)).toBe(0);

    const stored = await ds.query(
      `SELECT count(*)::int AS c FROM "checkin_log" WHERE "company_id" = $1`,
      [CO],
    );
    expect(stored[0].c).toBe(2);
  });

  it('counts only the new punches in a partially-overlapping batch', async () => {
    await repo.insertPunches(CO, [punch('1001', '2026-07-01 09:05:00')]);

    // Exactly the import-then-device-sync case: one punch already known, one new.
    const inserted = await repo.insertPunches(CO, [
      punch('1001', '2026-07-01 09:05:00'),
      punch('1001', '2026-07-01 18:10:00'),
    ]);

    expect(inserted).toBe(1);
  });

  it('keeps punches from different companies apart', async () => {
    const other = '00000000-0000-0000-0000-0000000000c9';
    await seedCompany(ds, other, 'Other Co');

    // The conflict key is (company, user, timestamp), so an identical punch in a second
    // company is a real insert, not a duplicate.
    expect(await repo.insertPunches(CO, [punch('1001', '2026-07-01 09:05:00')])).toBe(1);
    expect(await repo.insertPunches(other, [punch('1001', '2026-07-01 09:05:00')])).toBe(1);

    await ds.query(`DELETE FROM "checkin_log" WHERE "company_id" = $1`, [other]);
  });

  it('returns zero for an empty batch without touching the database', async () => {
    expect(await repo.insertPunches(CO, [])).toBe(0);
  });

  /**
   * The day-project resolution order (design §5.1) — evidence before guesswork.
   *
   * The old order read the EMPLOYEE's standing default first, so a site engineer whose default is
   * Site A who walked into head office and punched there had that day costed to a construction site.
   * Job costing is downstream of this single clause, which is why it is proven against a real DB
   * rather than a stubbed repository.
   */
  describe('reconcileDays project resolution (real Postgres)', () => {
    beforeEach(async () => {
      await ds.query(`DELETE FROM "attendance_record" WHERE "company_id" = $1`, [CO]);
      await ds.query(`DELETE FROM "checkin_log" WHERE "company_id" = $1`, [CO]);
    });

    it('resolves the day project from the punch, outranking the device and employee defaults', async () => {
      await repo.insertPunches(CO, [punch('E100', '2026-07-10 09:00:00', PROJECT_C)]);

      const outcome = await repo.reconcileDays(CO, PROJECT_B, [
        { userId: 'E100', attendanceDate: '2026-07-10' },
      ]);

      expect(outcome.reconciled).toBe(1);
      const [row] = await ds.query(
        `SELECT "project_id"::text AS "projectId" FROM "attendance_record"
          WHERE "company_id" = $1 AND "attendance_date" = '2026-07-10' AND "mode" = 'OFFICE'`,
        [CO],
      );
      expect(row.projectId).toBe(PROJECT_C);
    });

    it('falls back to the DEVICE default before the employee default when no punch carries a project', async () => {
      await repo.insertPunches(CO, [punch('E100', '2026-07-11 09:00:00')]);

      await repo.reconcileDays(CO, PROJECT_B, [{ userId: 'E100', attendanceDate: '2026-07-11' }]);

      const [row] = await ds.query(
        `SELECT "project_id"::text AS "projectId" FROM "attendance_record"
          WHERE "company_id" = $1 AND "attendance_date" = '2026-07-11' AND "mode" = 'OFFICE'`,
        [CO],
      );
      expect(row.projectId).toBe(PROJECT_B); // the device default, NOT the employee's PROJECT_A
    });

    it('falls back to the EMPLOYEE default only when neither punch nor device states one', async () => {
      await repo.insertPunches(CO, [punch('E100', '2026-07-12 09:00:00')]);

      await repo.reconcileDays(CO, null, [{ userId: 'E100', attendanceDate: '2026-07-12' }]);

      const [row] = await ds.query(
        `SELECT "project_id"::text AS "projectId" FROM "attendance_record"
          WHERE "company_id" = $1 AND "attendance_date" = '2026-07-12' AND "mode" = 'OFFICE'`,
        [CO],
      );
      expect(row.projectId).toBe(PROJECT_A);
    });

    it('lets the LATEST stating punch win — an afternoon site visit outranks a morning office punch', async () => {
      await repo.insertPunches(CO, [
        punch('E100', '2026-07-13 09:00:00', PROJECT_B),
        punch('E100', '2026-07-13 14:30:00', PROJECT_C),
      ]);

      await repo.reconcileDays(CO, null, [{ userId: 'E100', attendanceDate: '2026-07-13' }]);

      const [row] = await ds.query(
        `SELECT "project_id"::text AS "projectId" FROM "attendance_record"
          WHERE "company_id" = $1 AND "attendance_date" = '2026-07-13' AND "mode" = 'OFFICE'`,
        [CO],
      );
      expect(row.projectId).toBe(PROJECT_C);
    });

    it('skips the day as NO_PROJECT rather than guessing when none of the three states one', async () => {
      await ds.query(`UPDATE "employee" SET "default_project_id" = NULL WHERE "id" = $1`, [EMPLOYEE]);
      try {
        await repo.insertPunches(CO, [punch('E100', '2026-07-14 09:00:00')]);

        const outcome = await repo.reconcileDays(CO, null, [
          { userId: 'E100', attendanceDate: '2026-07-14' },
        ]);

        expect(outcome.reconciled).toBe(0);
        expect(outcome.skipped).toEqual([
          { userId: 'E100', attendanceDate: '2026-07-14', reason: 'NO_PROJECT' },
        ]);
      } finally {
        await ds.query(`UPDATE "employee" SET "default_project_id" = $2 WHERE "id" = $1`, [
          EMPLOYEE,
          PROJECT_A,
        ]);
      }
    });

    it('never re-tags an existing day: the UPDATE branch writes times, never project_id', async () => {
      // This is what makes the reorder safe to ship — historical rows keep the project they were
      // costed to, so the new order can only affect days created after it landed.
      await repo.insertPunches(CO, [punch('E100', '2026-07-15 09:00:00')]);
      await repo.reconcileDays(CO, PROJECT_B, [{ userId: 'E100', attendanceDate: '2026-07-15' }]);

      await repo.insertPunches(CO, [punch('E100', '2026-07-15 18:10:00', PROJECT_C)]);
      await repo.reconcileDays(CO, PROJECT_B, [{ userId: 'E100', attendanceDate: '2026-07-15' }]);

      const [row] = await ds.query(
        `SELECT "project_id"::text AS "projectId", "check_out"::text AS "checkOut"
           FROM "attendance_record"
          WHERE "company_id" = $1 AND "attendance_date" = '2026-07-15' AND "mode" = 'OFFICE'`,
        [CO],
      );
      expect(row.projectId).toBe(PROJECT_B); // unchanged, even though a later punch states PROJECT_C
      expect(row.checkOut).toBe('18:10:00'); // the times DID merge
    });
  });
});
