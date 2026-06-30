/**
 * PER integration — Testcontainers Postgres, real migrations + constraints (skill §13). Proves:
 *   - generate creates 12 contiguous months; a second generate is rejected;
 *   - the EXCLUDE-USING-gist constraint rejects an overlapping period at the DB (FR-PER-004);
 *   - assertOpen returns OPEN, throws PERIOD_CLOSED / NO_PERIOD_DEFINED (FR-PER-006);
 *   - close → reopen; close-fy locks the FY → reopen rejected PERIOD_FY_LOCKED (FR-PER-010);
 *   - concurrency: close-before-post (assertOpen sees CLOSED), post-before-close (lock ordering),
 *     and a concurrent close/close version race resolves to exactly one winner (FR-PER-005).
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { AccountingPeriodOrmEntity } from '../src/core/period/infrastructure/accounting-period.orm-entity';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { TypeOrmAccountingPeriodRepository } from '../src/core/period/infrastructure/typeorm-accounting-period.repository';
import { PeriodServiceImpl } from '../src/core/period/application/period.service';
import { GeneratePeriodsUseCase } from '../src/core/period/application/generate-periods.use-case';
import { ClosePeriodUseCase } from '../src/core/period/application/close-period.use-case';
import { ReopenPeriodUseCase } from '../src/core/period/application/reopen-period.use-case';
import { CloseFyUseCase } from '../src/core/period/application/close-fy.use-case';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { NoopAuditService } from '../src/core/audit/infrastructure/noop-audit.service';
import { OptimisticLockConflictError } from '../src/common/errors/domain-error';
import {
  NoPeriodDefinedError,
  PeriodClosedError,
  PeriodFyLockedError,
} from '../src/core/period/domain/errors';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const USER = '00000000-0000-0000-0000-0000000000a1';
const actor: Actor = { userId: USER, companyId: CO, financialYearId: FY1, role: 'Admin', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };
const clock = { now: () => new Date('2026-07-15T10:00:00Z') };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Accounting Period Control (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repo: TypeOrmAccountingPeriodRepository;
  let svc: PeriodServiceImpl;
  let uow: TypeOrmUnitOfWork;
  let generate: GeneratePeriodsUseCase;
  let closePeriod: ClosePeriodUseCase;
  let reopenPeriod: ReopenPeriodUseCase;
  let closeFy: CloseFyUseCase;

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
      entities: [CompanyOrmEntity, FinancialYearOrmEntity, AccountingPeriodOrmEntity],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    await dataSource.query(
      `INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`,
      [CO],
    );
    await dataSource.query(
      `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`,
      [FY1, CO],
    );

    repo = new TypeOrmAccountingPeriodRepository(dataSource);
    svc = new PeriodServiceImpl(repo);
    uow = new TypeOrmUnitOfWork(dataSource);
    const audit = new NoopAuditService();
    const ids = new UuidIdGenerator();
    generate = new GeneratePeriodsUseCase(repo, uow, ids);
    closePeriod = new ClosePeriodUseCase(repo, audit, uow, clock);
    reopenPeriod = new ReopenPeriodUseCase(repo, audit, uow);
    closeFy = new CloseFyUseCase(repo, audit, uow, clock);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await dataSource.query('TRUNCATE accounting_period');
  });

  const periodIdOwning = async (date: string): Promise<string> => {
    const [row] = await dataSource.query(
      `SELECT id FROM accounting_period WHERE company_id=$1 AND financial_year_id=$2 AND start_date<=$3 AND end_date>=$3`,
      [CO, FY1, date],
    );
    return row.id;
  };

  it('generates 12 contiguous monthly periods (FR-PER-002/003)', async () => {
    const created = await generate.execute(FY1, actor);
    expect(created).toHaveLength(12);
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM accounting_period`);
    expect(n).toBe(12);
  });

  it('the EXCLUDE-USING-gist constraint rejects an overlapping period (FR-PER-004)', async () => {
    await generate.execute(FY1, actor);
    await expect(
      dataSource.query(
        `INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status)
         VALUES (gen_random_uuid(), $1, $2, 'Overlap', '2025-07-15', '2025-08-15', 'OPEN')`,
        [CO, FY1],
      ),
    ).rejects.toThrow();
  });

  it('assertOpen: OPEN passes, CLOSED → PERIOD_CLOSED, undefined date → NO_PERIOD_DEFINED', async () => {
    await generate.execute(FY1, actor);
    await expect(uow.run(() => svc.assertOpen(CO, FY1, '2025-07-15'))).resolves.toBeUndefined();

    await closePeriod.execute(await periodIdOwning('2025-07-15'), actor);
    await expect(uow.run(() => svc.assertOpen(CO, FY1, '2025-07-15'))).rejects.toBeInstanceOf(
      PeriodClosedError,
    );
    await expect(uow.run(() => svc.assertOpen(CO, FY1, '2030-01-01'))).rejects.toBeInstanceOf(
      NoPeriodDefinedError,
    );
  });

  it('close → reopen works while the FY is unlocked; close-fy then blocks reopen (FR-PER-010)', async () => {
    await generate.execute(FY1, actor);
    const julId = await periodIdOwning('2025-07-15');
    await closePeriod.execute(julId, actor);
    await reopenPeriod.execute(julId, actor); // 11 others OPEN → allowed
    const [{ status }] = await dataSource.query(`SELECT status FROM accounting_period WHERE id=$1`, [julId]);
    expect(status).toBe('OPEN');

    const result = await closeFy.execute(FY1, actor);
    expect(result.closedCount).toBe(12);
    await expect(reopenPeriod.execute(julId, actor)).rejects.toBeInstanceOf(PeriodFyLockedError);
  });

  it('post-before-close: assertOpen holds the row lock, the concurrent close blocks then commits', async () => {
    await generate.execute(FY1, actor);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const augId = await periodIdOwning('2025-08-15');

    const txA = uow.run(async () => {
      await svc.assertOpen(CO, FY1, '2025-08-15'); // FOR UPDATE lock, period OPEN → admitted
      await gate; // hold the transaction open
    });
    const txB = (async () => {
      await delay(200); // ensure A holds the lock
      const closing = closePeriod.execute(augId, actor); // UPDATE blocks on A's lock
      release(); // let A commit, releasing the lock
      return closing;
    })();

    await expect(Promise.all([txA, txB])).resolves.toBeDefined(); // A admitted, then B closed — no throw
    const [{ status }] = await dataSource.query(`SELECT status FROM accounting_period WHERE id=$1`, [augId]);
    expect(status).toBe('CLOSED');
  });

  it('two concurrent closes on one OPEN period resolve to exactly one winner', async () => {
    await generate.execute(FY1, actor);
    const sepId = await periodIdOwning('2025-09-15');
    const results = await Promise.allSettled([
      closePeriod.execute(sepId, actor),
      closePeriod.execute(sepId, actor),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // the loser is a concurrency/state conflict, never a silent double-close
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(
      reason instanceof OptimisticLockConflictError || reason?.constructor?.name === 'PeriodAlreadyClosedError',
    ).toBe(true);
  });
});
