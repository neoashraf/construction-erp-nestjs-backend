/**
 * Master Data (Company + FinancialYear) integration — Testcontainers Postgres, real migration + real
 * repositories/use cases (skill §13). Proves the guarantees that can't be faked:
 *   - the migration builds the schema and the `(company_id) WHERE is_active` PARTIAL-UNIQUE index;
 *   - set-active keeps EXACTLY ONE active FY per company, atomically (FR-MAS-003, edge §12.7);
 *   - the `end_date > start_date` CHECK and the `ON DELETE RESTRICT` FK hold at the DB;
 *   - optimistic concurrency rejects a stale write (FR-MAS-032).
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { TypeOrmCompanyRepository } from '../src/modules/master-data/company/infrastructure/persistence/typeorm-company.repository';
import { TypeOrmFinancialYearRepository } from '../src/modules/master-data/financial-year/infrastructure/persistence/typeorm-financial-year.repository';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { NoopAuditService } from '../src/modules/master-data/infrastructure/noop-audit.service';
import { CreateCompanyUseCase } from '../src/modules/master-data/application/company/create-company.use-case';
import { UpdateCompanyUseCase } from '../src/modules/master-data/application/company/update-company.use-case';
import { CreateFinancialYearUseCase } from '../src/modules/master-data/application/financial-year/create-financial-year.use-case';
import { SetActiveFinancialYearUseCase } from '../src/modules/master-data/application/financial-year/set-active-financial-year.use-case';
import { OptimisticLockConflictError } from '../src/common/errors/domain-error';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const VALID_COMPANY = {
  name: 'Zakir Enterprise',
  legalName: 'Zakir Enterprise Ltd.',
  bin: '1234567890123',
  tin: '123456789012',
};

describe('Master Data — Company + FinancialYear (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  // adapters + use cases (constructed with the real DataSource)
  let createCompany: CreateCompanyUseCase;
  let updateCompany: UpdateCompanyUseCase;
  let createFy: CreateFinancialYearUseCase;
  let setActiveFy: SetActiveFinancialYearUseCase;

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
      entities: [CompanyOrmEntity, FinancialYearOrmEntity],
      migrations: [InitialBaseline1700000000000, CreateCompanyFinancialYear1700000100000],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    const companies = new TypeOrmCompanyRepository(dataSource);
    const years = new TypeOrmFinancialYearRepository(dataSource);
    const uow = new TypeOrmUnitOfWork(dataSource);
    const ids = new UuidIdGenerator();
    const audit = new NoopAuditService();
    createCompany = new CreateCompanyUseCase(companies, audit, uow, ids);
    updateCompany = new UpdateCompanyUseCase(companies, audit, uow);
    createFy = new CreateFinancialYearUseCase(years, audit, uow, ids);
    setActiveFy = new SetActiveFinancialYearUseCase(years, audit, uow);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await dataSource.query('TRUNCATE financial_year, company CASCADE');
  });

  async function newCompanyActor(): Promise<Actor> {
    const { id } = await createCompany.execute(VALID_COMPANY, sysActor());
    return { userId: 'u-1', companyId: id, financialYearId: '', role: 'Admin' };
  }
  function sysActor(): Actor {
    return { userId: 'bootstrap', companyId: 'bootstrap', financialYearId: '', role: 'Admin' };
  }

  it('runs the migration and creates company + financial_year', async () => {
    const tables = await dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('company','financial_year') ORDER BY table_name`,
    );
    expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual([
      'company',
      'financial_year',
    ]);
  });

  it('persists a company (version 1) and an inactive financial year', async () => {
    const actor = await newCompanyActor();
    const { id: fyId } = await createFy.execute(
      { label: '2025-26', startDate: '2025-07-01', endDate: '2026-06-30' },
      actor,
    );
    const [row] = await dataSource.query(`SELECT is_active, version FROM financial_year WHERE id = $1`, [
      fyId,
    ]);
    expect(row.is_active).toBe(false);
    expect(row.version).toBe(1);
  });

  it('set-active keeps exactly one active FY per company, switching atomically (FR-MAS-003)', async () => {
    const actor = await newCompanyActor();
    const a = await createFy.execute({ label: '2025-26', startDate: '2025-07-01', endDate: '2026-06-30' }, actor);
    const b = await createFy.execute({ label: '2026-27', startDate: '2026-07-01', endDate: '2027-06-30' }, actor);

    await setActiveFy.execute(a.id, actor);
    await setActiveFy.execute(b.id, actor);

    const active = await dataSource.query(
      `SELECT id FROM financial_year WHERE company_id = $1 AND is_active`,
      [actor.companyId],
    );
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(b.id);
  });

  it('the partial-unique index rejects a second active FY at the DB', async () => {
    const actor = await newCompanyActor();
    await dataSource.query(
      `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active)
       VALUES (gen_random_uuid(), $1, 'A', '2025-07-01', '2026-06-30', true)`,
      [actor.companyId],
    );
    await expect(
      dataSource.query(
        `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active)
         VALUES (gen_random_uuid(), $1, 'B', '2026-07-01', '2027-06-30', true)`,
        [actor.companyId],
      ),
    ).rejects.toThrow();
  });

  it('the end_date > start_date CHECK rejects an inverted range', async () => {
    const actor = await newCompanyActor();
    await expect(
      dataSource.query(
        `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active)
         VALUES (gen_random_uuid(), $1, 'Bad', '2026-06-30', '2025-07-01', false)`,
        [actor.companyId],
      ),
    ).rejects.toThrow();
  });

  it('FK ON DELETE RESTRICT protects a referenced company, and rejects an orphan FY', async () => {
    const actor = await newCompanyActor();
    await createFy.execute({ label: '2025-26', startDate: '2025-07-01', endDate: '2026-06-30' }, actor);

    await expect(
      dataSource.query(`DELETE FROM company WHERE id = $1`, [actor.companyId]),
    ).rejects.toThrow();

    await expect(
      dataSource.query(
        `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active)
         VALUES (gen_random_uuid(), gen_random_uuid(), 'Orphan', '2025-07-01', '2026-06-30', false)`,
      ),
    ).rejects.toThrow();
  });

  it('optimistic concurrency rejects a stale update (FR-MAS-032)', async () => {
    const actor = await newCompanyActor();
    await updateCompany.execute(actor.companyId, { name: 'First' }, 1, actor); // → version 2

    const [row] = await dataSource.query(`SELECT version FROM company WHERE id = $1`, [actor.companyId]);
    expect(row.version).toBe(2);

    await expect(
      updateCompany.execute(actor.companyId, { name: 'Second' }, 1, actor),
    ).rejects.toBeInstanceOf(OptimisticLockConflictError);
  });
});
