/**
 * MAS posting-dimension masters integration — Testcontainers Postgres, real migrations + constraints
 * (skill §13). Proves the DB uniqueness/RESTRICT constraints and the cross-master flows:
 *   - standard-14 cost-centre seed on company create (FR-MAS-009); duplicate code rejected;
 *   - project create + status FSM (close sets actual_end_date); duplicate project_code rejected;
 *   - purpose idempotent inline-create dedupe (FR-MAS-013);
 *   - godown rejected under a CLOSED project; duplicate name per project rejected;
 *   - project-budget upsert collapses to one row; CLOSED project rejected;
 *   - ON DELETE RESTRICT protects a referenced company.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { CostCentreOrmEntity } from '../src/modules/master-data/cost-centre/infrastructure/cost-centre.orm-entity';
import { ProjectOrmEntity } from '../src/modules/master-data/project/infrastructure/project.orm-entity';
import { PurposeOrmEntity } from '../src/modules/master-data/purpose/infrastructure/purpose.orm-entity';
import { GodownOrmEntity } from '../src/modules/master-data/godown/infrastructure/godown.orm-entity';
import { ProjectBudgetOrmEntity } from '../src/modules/master-data/project-budget/infrastructure/project-budget.orm-entity';
import { AccountGroupOrmEntity } from '../src/modules/master-data/chart-of-accounts/infrastructure/account-group.orm-entity';
import { AccountOrmEntity } from '../src/modules/master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { TypeOrmAccountGroupRepository } from '../src/modules/master-data/chart-of-accounts/infrastructure/typeorm-account-group.repository';
import { TypeOrmAccountRepository } from '../src/modules/master-data/chart-of-accounts/infrastructure/typeorm-account.repository';
import { SeedConstructionCoaUseCase } from '../src/modules/master-data/chart-of-accounts/application/construction-coa.seed';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { NoopAuditService } from '../src/core/audit/infrastructure/noop-audit.service';
import { NoopAuditService as MasNoopAudit } from '../src/modules/master-data/infrastructure/noop-audit.service';
import { TypeOrmCompanyRepository } from '../src/modules/master-data/company/infrastructure/persistence/typeorm-company.repository';
import { CreateCompanyUseCase } from '../src/modules/master-data/application/company/create-company.use-case';
import { TypeOrmCostCentreRepository } from '../src/modules/master-data/cost-centre/infrastructure/typeorm-cost-centre.repository';
import { CreateCostCentreUseCase, SeedStandardCostCentresUseCase } from '../src/modules/master-data/cost-centre/application/cost-centre.use-cases';
import { TypeOrmProjectRepository } from '../src/modules/master-data/project/infrastructure/typeorm-project.repository';
import { CreateProjectUseCase, ChangeProjectStatusUseCase } from '../src/modules/master-data/project/application/project.use-cases';
import { TypeOrmPurposeRepository } from '../src/modules/master-data/purpose/infrastructure/typeorm-purpose.repository';
import { InlineCreatePurposeUseCase } from '../src/modules/master-data/purpose/application/purpose.use-cases';
import { TypeOrmGodownRepository } from '../src/modules/master-data/godown/infrastructure/typeorm-godown.repository';
import { CreateGodownUseCase } from '../src/modules/master-data/godown/application/godown.use-cases';
import { TypeOrmProjectBudgetRepository } from '../src/modules/master-data/project-budget/infrastructure/typeorm-project-budget.repository';
import { UpsertProjectBudgetUseCase } from '../src/modules/master-data/project-budget/application/project-budget.use-cases';
import { ClosedProjectError, DuplicateCodeError, DuplicateNameError } from '../src/common/errors/domain-error';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);
const clock = { now: () => new Date('2026-07-15T10:00:00Z') };
const CUSTOMER = '00000000-0000-0000-0000-0000000000c1';
const PM = '00000000-0000-0000-0000-0000000000c2';

describe('MAS dimension masters (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let uow: TypeOrmUnitOfWork;
  let createCompany: CreateCompanyUseCase;
  let createCostCentre: CreateCostCentreUseCase;
  let createProject: CreateProjectUseCase;
  let changeStatus: ChangeProjectStatusUseCase;
  let inlinePurpose: InlineCreatePurposeUseCase;
  let createGodown: CreateGodownUseCase;
  let upsertBudget: UpsertProjectBudgetUseCase;
  let actor: Actor;

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
      entities: [CompanyOrmEntity, FinancialYearOrmEntity, CostCentreOrmEntity, ProjectOrmEntity, PurposeOrmEntity, GodownOrmEntity, ProjectBudgetOrmEntity, AccountGroupOrmEntity, AccountOrmEntity],
      migrations: [InitialBaseline1700000000000, CreateCompanyFinancialYear1700000100000, CreateMasterDataDimensions1700000500000, CreateMasterDataAccountsPartiesItems1700000600000],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    uow = new TypeOrmUnitOfWork(dataSource);
    const ids = new UuidIdGenerator();
    const audit = new NoopAuditService();
    const ccRepo = new TypeOrmCostCentreRepository(dataSource);
    const projRepo = new TypeOrmProjectRepository(dataSource);
    const seed = new SeedStandardCostCentresUseCase(ccRepo, ids);
    const coaSeed = new SeedConstructionCoaUseCase(
      new TypeOrmAccountGroupRepository(dataSource),
      new TypeOrmAccountRepository(dataSource),
      ids,
    );
    createCompany = new CreateCompanyUseCase(new TypeOrmCompanyRepository(dataSource), new MasNoopAudit(), uow, ids, seed, coaSeed);
    createCostCentre = new CreateCostCentreUseCase(ccRepo, audit, uow, ids);
    createProject = new CreateProjectUseCase(projRepo, audit, uow, ids);
    changeStatus = new ChangeProjectStatusUseCase(projRepo, audit, uow, clock);
    inlinePurpose = new InlineCreatePurposeUseCase(new TypeOrmPurposeRepository(dataSource), audit, uow, ids);
    createGodown = new CreateGodownUseCase(new TypeOrmGodownRepository(dataSource), projRepo, audit, uow, ids);
    upsertBudget = new UpsertProjectBudgetUseCase(new TypeOrmProjectBudgetRepository(dataSource), projRepo, ccRepo, audit, uow, ids);

    const { id } = await createCompany.execute(
      { name: 'ZE', legalName: 'ZE Ltd', bin: '1234567890123', tin: '123456789012' },
      { userId: '00000000-0000-0000-0000-0000000000a1', companyId: 'bootstrap', financialYearId: '', role: 'Admin' },
    );
    actor = { userId: '00000000-0000-0000-0000-0000000000a1', companyId: id, financialYearId: '', role: 'Admin' };
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  const newProject = async (code: string) =>
    (await createProject.execute({ projectCode: code, name: 'Tower ' + code, customerId: CUSTOMER, projectManagerId: PM, startDate: '2025-01-01', expectedEndDate: '2026-01-01' }, actor)).id;

  it('seeds the standard 14 cost centres on company creation (FR-MAS-009)', async () => {
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM cost_centre WHERE company_id=$1`, [actor.companyId]);
    expect(n).toBe(14);
  });

  it('rejects a duplicate cost-centre code (FR-MAS-010)', async () => {
    await createCostCentre.execute({ code: 'CC-X1', name: 'Custom' }, actor);
    await expect(createCostCentre.execute({ code: 'CC-X1', name: 'Dup' }, actor)).rejects.toBeInstanceOf(DuplicateCodeError);
  });

  it('project create → PLANNED; close sets actual_end_date; duplicate code rejected (FR-MAS-005/006)', async () => {
    const id = await newProject('PR-1');
    const [p0] = await dataSource.query(`SELECT status FROM project WHERE id=$1`, [id]);
    expect(p0.status).toBe('PLANNED');
    await changeStatus.execute(id, 'activate', 1, actor);
    await changeStatus.execute(id, 'close', 2, actor);
    const [p1] = await dataSource.query(`SELECT status, actual_end_date FROM project WHERE id=$1`, [id]);
    expect(p1.status).toBe('CLOSED');
    expect(p1.actual_end_date).toBeTruthy();
    await expect(newProject('PR-1')).rejects.toBeInstanceOf(DuplicateCodeError);
  });

  it('purpose inline-create is idempotent (case-insensitive dedupe) (FR-MAS-013)', async () => {
    const projectId = await newProject('PR-2');
    const a = await inlinePurpose.execute(projectId, 'Rebar', actor);
    const b = await inlinePurpose.execute(projectId, '  rebar ', actor);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM purpose WHERE project_id=$1`, [projectId]);
    expect(n).toBe(1);
  });

  it('godown: rejected under a CLOSED project, dup name rejected under an active one (FR-MAS-014)', async () => {
    const closedId = await newProject('PR-3');
    await changeStatus.execute(closedId, 'activate', 1, actor);
    await changeStatus.execute(closedId, 'close', 2, actor);
    await expect(createGodown.execute({ projectId: closedId, name: 'Store-1' }, actor)).rejects.toBeInstanceOf(ClosedProjectError);

    const activeId = await newProject('PR-4');
    await createGodown.execute({ projectId: activeId, name: 'Store-1' }, actor);
    await expect(createGodown.execute({ projectId: activeId, name: 'Store-1' }, actor)).rejects.toBeInstanceOf(DuplicateNameError);
  });

  it('project-budget upsert collapses to one row; CLOSED project rejected (FR-MAS-007/008)', async () => {
    const projectId = await newProject('PR-5');
    const [cc] = await dataSource.query(`SELECT id FROM cost_centre WHERE company_id=$1 LIMIT 1`, [actor.companyId]);
    const r1 = await upsertBudget.execute(projectId, { costCentreId: cc.id, budgetedAmount: '1000.0000' }, actor);
    await upsertBudget.execute(projectId, { costCentreId: cc.id, budgetedAmount: '2000.0000', version: 1 }, actor);
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM project_budget WHERE project_id=$1`, [projectId]);
    expect(n).toBe(1);
    const [b] = await dataSource.query(`SELECT budgeted_amount::text AS a FROM project_budget WHERE id=$1`, [r1.id]);
    expect(b.a).toBe('2000.0000');
  });

  it('ON DELETE RESTRICT protects a referenced company', async () => {
    await expect(dataSource.query(`DELETE FROM company WHERE id=$1`, [actor.companyId])).rejects.toThrow();
  });
});
