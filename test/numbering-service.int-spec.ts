/**
 * NumberingService integration — Testcontainers Postgres, real migrations + the locked-counter
 * allocator (skill §13). Proves the guarantees that can't be faked (FR-NUM-009..014):
 *   - happy-path format `IPC/2526/0001` + increment;
 *   - a rolled-back post consumes NO number (no gap);
 *   - two concurrent allocations are serialised → consecutive, no dup/gap;
 *   - two concurrent FIRST-EVER posts auto-provision exactly ONE row (unique-violation race) + consecutive;
 *   - FY rollover resets to 1 in a new row;
 *   - gap-audit read.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { NumberingSeriesOrmEntity } from '../src/core/numbering/infrastructure/numbering-series.orm-entity';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { TypeOrmNumberingService } from '../src/core/numbering/infrastructure/typeorm-numbering.service';
import { NumberingSeriesReadService } from '../src/core/numbering/read/numbering-series.read-service';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const FY2 = '00000000-0000-0000-0000-0000000000f2';

function seq(formatted: string): number {
  return parseInt(formatted.split('/')[2], 10);
}

describe('NumberingService (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let num: TypeOrmNumberingService;
  let uow: TypeOrmUnitOfWork;
  let read: NumberingSeriesReadService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      synchronize: false,
      entities: [CompanyOrmEntity, FinancialYearOrmEntity, NumberingSeriesOrmEntity],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    await dataSource.query(
      `INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`,
      [CO],
    );
    await dataSource.query(
      `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active)
       VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true), ($3,$2,'2026-27','2026-07-01','2027-06-30',false)`,
      [FY1, CO, FY2],
    );

    num = new TypeOrmNumberingService(new UuidIdGenerator());
    uow = new TypeOrmUnitOfWork(dataSource);
    read = new NumberingSeriesReadService(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await dataSource.query('TRUNCATE numbering_series');
  });

  const allocate = (vt = 'SALES_IPC', fy = FY1) => uow.run(() => num.next(vt as never, CO, fy));

  it('allocates IPC/2526/0001 and increments last_sequence (FR-NUM-003/013)', async () => {
    expect(await allocate()).toBe('IPC/2526/0001');
    expect(await allocate()).toBe('IPC/2526/0002');
    const [row] = await dataSource.query(`SELECT last_sequence FROM numbering_series`);
    expect(row.last_sequence).toBe(2);
  });

  it('a rolled-back post consumes NO number — next post reuses the sequence (FR-NUM-010)', async () => {
    expect(await allocate()).toBe('IPC/2526/0001'); // last_sequence = 1
    await expect(
      uow.run(async () => {
        await num.next('SALES_IPC', CO, FY1); // would be 0002, within the tx
        throw new Error('boom'); // ... but the tx rolls back
      }),
    ).rejects.toThrow('boom');
    expect(await allocate()).toBe('IPC/2526/0002'); // 0002 reused — no gap to 0003
    const [row] = await dataSource.query(`SELECT last_sequence FROM numbering_series`);
    expect(row.last_sequence).toBe(2);
  });

  it('serialises two concurrent allocations into consecutive numbers, no dup/gap (FR-NUM-011)', async () => {
    await allocate(); // provision + 0001
    const [a, b] = await Promise.all([allocate(), allocate()]);
    expect(new Set([seq(a), seq(b)])).toEqual(new Set([2, 3]));
    const [row] = await dataSource.query(`SELECT last_sequence FROM numbering_series`);
    expect(row.last_sequence).toBe(3);
  });

  it('two concurrent FIRST-EVER posts auto-provision exactly one row + consecutive (FR-NUM-001/004)', async () => {
    const [a, b] = await Promise.all([allocate(), allocate()]);
    const rows = await dataSource.query(
      `SELECT count(*)::int AS n, max(last_sequence) AS last FROM numbering_series WHERE company_id=$1 AND financial_year_id=$2 AND voucher_type='SALES_IPC'`,
      [CO, FY1],
    );
    expect(rows[0].n).toBe(1); // exactly one series row despite the race
    expect(rows[0].last).toBe(2);
    expect(new Set([seq(a), seq(b)])).toEqual(new Set([1, 2]));
  });

  it('FY rollover starts a fresh series at 1 in a new row (FR-NUM-014)', async () => {
    expect(await allocate('SALES_IPC', FY1)).toBe('IPC/2526/0001');
    expect(await allocate('SALES_IPC', FY2)).toBe('IPC/2627/0001'); // new FY → new row, seq 1
    const rows = await dataSource.query(`SELECT count(*)::int AS n FROM numbering_series WHERE voucher_type='SALES_IPC'`);
    expect(rows[0].n).toBe(2);
  });

  it('gap-audit reports a continuous series (FR-NUM-021)', async () => {
    await allocate();
    await allocate();
    const [series] = await dataSource.query(`SELECT id FROM numbering_series LIMIT 1`);
    const actor: Actor = { userId: 'u', companyId: CO, financialYearId: FY1, role: 'Admin', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };
    const audit = await read.gapAudit(series.id, actor);
    expect(audit).toMatchObject({
      lowestSequence: 1,
      highestSequence: 2,
      committedCount: 2,
      expectedCount: 2,
      continuous: true,
      integrityAlert: false,
    });
  });
});
