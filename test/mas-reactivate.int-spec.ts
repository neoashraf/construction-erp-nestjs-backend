/**
 * MAS reactivate integration — Testcontainers Postgres, real migrations.
 * AC1: deactivated cost-centre reactivates and reappears in the active-only list (FR-MAS-033).
 * AC2: stale version on reactivate → OptimisticLockConflictError (FR-MAS-032).
 * AC3: PM cannot reactivate a godown belonging to a non-assigned project (FR-MAS-033 / FR-AUD-014).
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
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { NoopAuditService } from '../src/core/audit/infrastructure/noop-audit.service';
import { NoopAuditService as MasNoopAudit } from '../src/modules/master-data/infrastructure/noop-audit.service';
import { TypeOrmCompanyRepository } from '../src/modules/master-data/company/infrastructure/persistence/typeorm-company.repository';
import { CreateCompanyUseCase } from '../src/modules/master-data/application/company/create-company.use-case';
import { TypeOrmCostCentreRepository } from '../src/modules/master-data/cost-centre/infrastructure/typeorm-cost-centre.repository';
import {
  CreateCostCentreUseCase,
  DeactivateCostCentreUseCase,
  ReactivateCostCentreUseCase,
  SeedStandardCostCentresUseCase,
} from '../src/modules/master-data/cost-centre/application/cost-centre.use-cases';
import { CostCentreQueryService } from '../src/modules/master-data/cost-centre/read/cost-centre.query-service';
import { TypeOrmProjectRepository } from '../src/modules/master-data/project/infrastructure/typeorm-project.repository';
import { CreateProjectUseCase } from '../src/modules/master-data/project/application/project.use-cases';
import { TypeOrmGodownRepository } from '../src/modules/master-data/godown/infrastructure/typeorm-godown.repository';
import { CreateGodownUseCase, SetGodownActiveUseCase } from '../src/modules/master-data/godown/application/godown.use-cases';
import { TypeOrmAccountGroupRepository } from '../src/modules/master-data/chart-of-accounts/infrastructure/typeorm-account-group.repository';
import { TypeOrmAccountRepository } from '../src/modules/master-data/chart-of-accounts/infrastructure/typeorm-account.repository';
import { SeedConstructionCoaUseCase } from '../src/modules/master-data/chart-of-accounts/application/construction-coa.seed';
import { AccessPolicy, ForbiddenScopeError } from '../src/core/auth/domain/access-policy';
import { OptimisticLockConflictError } from '../src/common/errors/domain-error';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CUSTOMER = '00000000-0000-0000-0000-0000000000c1';
const PM_USER  = '00000000-0000-0000-0000-0000000000c2';

describe('MAS reactivate (real Postgres, FR-MAS-033/032)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let actor: Actor;

  let createCostCentre: CreateCostCentreUseCase;
  let deactivateCostCentre: DeactivateCostCentreUseCase;
  let reactivateCostCentre: ReactivateCostCentreUseCase;
  let costCentreQuery: CostCentreQueryService;

  let createProject: CreateProjectUseCase;
  let createGodown: CreateGodownUseCase;
  let setGodownActive: SetGodownActiveUseCase;

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
      entities: [
        CompanyOrmEntity,
        FinancialYearOrmEntity,
        CostCentreOrmEntity,
        ProjectOrmEntity,
        PurposeOrmEntity,
        GodownOrmEntity,
        ProjectBudgetOrmEntity,
        AccountGroupOrmEntity,
        AccountOrmEntity,
      ],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    const uow  = new TypeOrmUnitOfWork(dataSource);
    const ids  = new UuidIdGenerator();
    const audit = new NoopAuditService();

    const ccRepo      = new TypeOrmCostCentreRepository(dataSource);
    const projRepo    = new TypeOrmProjectRepository(dataSource);
    const godownRepo  = new TypeOrmGodownRepository(dataSource);
    const policy      = new AccessPolicy();

    const seed = new SeedStandardCostCentresUseCase(ccRepo, ids);
    const coaSeed = new SeedConstructionCoaUseCase(
      new TypeOrmAccountGroupRepository(dataSource),
      new TypeOrmAccountRepository(dataSource),
      ids,
    );
    const createCompany = new CreateCompanyUseCase(
      new TypeOrmCompanyRepository(dataSource),
      new MasNoopAudit(),
      uow,
      ids,
      seed,
      coaSeed,
    );

    const { id: companyId } = await createCompany.execute(
      { name: 'ZE', legalName: 'ZE Ltd', bin: '1234567890123', tin: '123456789012' },
      { userId: '00000000-0000-0000-0000-0000000000a1', companyId: 'bootstrap', financialYearId: '', role: 'Admin', isUnscoped: true, assignedProjectIds: [], approvalLimit: null },
    );

    actor = { userId: '00000000-0000-0000-0000-0000000000a1', companyId, financialYearId: '', role: 'Admin', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };

    createCostCentre    = new CreateCostCentreUseCase(ccRepo, audit, uow, ids);
    deactivateCostCentre = new DeactivateCostCentreUseCase(ccRepo, audit, uow);
    reactivateCostCentre = new ReactivateCostCentreUseCase(ccRepo, audit, uow);
    costCentreQuery      = new CostCentreQueryService(dataSource);

    createProject   = new CreateProjectUseCase(projRepo, audit, uow, ids);
    createGodown    = new CreateGodownUseCase(godownRepo, projRepo, audit, uow, ids);
    setGodownActive = new SetGodownActiveUseCase(godownRepo, audit, uow, policy);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  // ── AC1: cost-centre deactivate → reactivate → appears in active-only list ──

  it('AC1: reactivated cost-centre reappears in the active-only list (FR-MAS-033)', async () => {
    const { id } = await createCostCentre.execute({ code: 'CC-TST', name: 'Test Centre' }, actor);

    await deactivateCostCentre.execute(id, 1, actor);
    let [row] = await dataSource.query(`SELECT is_active, version FROM cost_centre WHERE id=$1`, [id]);
    expect(row.is_active).toBe(false);

    // active-only list should NOT include it while deactivated
    const before = await costCentreQuery.list({ isActive: true }, actor);
    expect(before.items.some((c) => c.id === id)).toBe(false);

    await reactivateCostCentre.execute(id, row.version, actor);
    [row] = await dataSource.query(`SELECT is_active FROM cost_centre WHERE id=$1`, [id]);
    expect(row.is_active).toBe(true);

    // active-only list must include it now
    const after = await costCentreQuery.list({ isActive: true }, actor);
    expect(after.items.some((c) => c.id === id)).toBe(true);
  });

  // ── AC2: stale version on reactivate → OptimisticLockConflictError ──

  it('AC2: stale version rejected on reactivate (FR-MAS-032)', async () => {
    const { id } = await createCostCentre.execute({ code: 'CC-STV', name: 'Stale Test' }, actor);
    await deactivateCostCentre.execute(id, 1, actor);
    // version is now 2; try to reactivate with the old version 1
    await expect(reactivateCostCentre.execute(id, 1, actor)).rejects.toBeInstanceOf(OptimisticLockConflictError);
  });

  // ── AC3: PM cannot reactivate a godown in a non-assigned project ──

  it('AC3: PM cannot reactivate a godown outside their assigned projects (FR-MAS-033 / FR-AUD-014)', async () => {
    // Create two projects; PM is only assigned to proj-B
    const projA = (await createProject.execute(
      { projectCode: 'PA-1', name: 'Project A', customerId: CUSTOMER, projectManagerId: PM_USER, startDate: '2025-01-01', expectedEndDate: '2026-01-01' },
      actor,
    )).id;

    const projB = (await createProject.execute(
      { projectCode: 'PB-1', name: 'Project B', customerId: CUSTOMER, projectManagerId: PM_USER, startDate: '2025-01-01', expectedEndDate: '2026-01-01' },
      actor,
    )).id;

    // Admin creates + deactivates a godown under project-A
    const { id: gdId } = await createGodown.execute({ projectId: projA, name: 'Store Alpha' }, actor);
    await setGodownActive.execute(gdId, 1, false, actor); // deactivate

    // PM actor with only project-B assigned
    const pmActor: Actor = {
      userId: PM_USER,
      companyId: actor.companyId,
      financialYearId: '',
      role: 'PM',
      isUnscoped: false,
      assignedProjectIds: [projB],
      approvalLimit: null,
    };

    // PM must be blocked
    await expect(setGodownActive.execute(gdId, 2, true, pmActor)).rejects.toBeInstanceOf(ForbiddenScopeError);
  });
});
