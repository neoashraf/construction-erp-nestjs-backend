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

import { TypeOrmPunchIngestionRepository } from '../src/modules/hr/attendance-reports/infrastructure/typeorm-punch-ingestion.repository';
import type { PunchToStore } from '../src/modules/hr/attendance-reports/domain/ports/punch-ingestion.repository';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';

/** `company` has several NOT NULL columns with no default; all of them must be supplied. */
async function seedCompany(ds: DataSource, id: string, name: string): Promise<void> {
  await ds.query(
    `INSERT INTO "company" ("id", "name", "legal_name", "bin", "tin", "created_at", "updated_at")
     VALUES ($1, $2, $2, $3, $4, now(), now())
     ON CONFLICT ("id") DO NOTHING`,
    [id, name, `BIN-${id.slice(-4)}`, `TIN-${id.slice(-4)}`],
  );
}

function punch(userId: string, deviceTimestamp: string): PunchToStore {
  return {
    sourceType: 'EXCEL_IMPORT',
    userId,
    deviceTimestamp,
    status: '0',
    occurredAt: null,
    deviceSn: null,
  };
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
      ],
    });
    await ds.initialize();
    await ds.runMigrations();

    await seedCompany(ds, CO, 'Probe Co');

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
});
