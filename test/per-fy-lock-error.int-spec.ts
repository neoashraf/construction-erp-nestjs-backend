/**
 * per-fy-lock-error integration — Testcontainers Postgres, real migrations (skill §13).
 * Exercises the FULL evaluation order on POST /api/periods/:id/reopen (FR-PER-009/010):
 *   auth/permission (RolesGuard, {module:'PER',action:'UPDATE'}) -> FORBIDDEN 403
 *   -> existence -> PERIOD_NOT_FOUND 404
 *   -> state: FSM (PERIOD_ALREADY_OPEN) / year-lock (PERIOD_FY_LOCKED) -> 409
 *   -> optimistic version -> OPTIMISTIC_LOCK_CONFLICT.
 *
 * AC1: close-fy on an FY then attempt reopen of one of its periods -> PERIOD_FY_LOCKED (real RolesGuard
 *      + real ReopenPeriodUseCase against a real DB).
 * AC2: a caller WITH `period.reopen` (ADMIN, {PER,UPDATE} granted) still gets PERIOD_FY_LOCKED on a
 *      locked FY — permission does not bypass the state check.
 * AC3: a caller WITHOUT `period.reopen` (PROJECT_MANAGER, no PER permission) gets FORBIDDEN — checked
 *      BEFORE any state/use-case logic runs (RolesGuard never invokes the use case).
 * AC4: normal reopen (FY not fully closed) is unchanged: succeeds, status=OPEN, closed_at/closed_by
 *      cleared, audit-logged.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { AccountingPeriodOrmEntity } from '../src/core/period/infrastructure/accounting-period.orm-entity';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateUser1700000700000 } from '../src/database/migrations/1700000700000-CreateUser';
import { CreateRbacAndAudit1700000800000 } from '../src/database/migrations/1700000800000-CreateRbacAndAudit';
import { TypeOrmAccountingPeriodRepository } from '../src/core/period/infrastructure/typeorm-accounting-period.repository';
import { GeneratePeriodsUseCase } from '../src/core/period/application/generate-periods.use-case';
import { ClosePeriodUseCase } from '../src/core/period/application/close-period.use-case';
import { ReopenPeriodUseCase } from '../src/core/period/application/reopen-period.use-case';
import { CloseFyUseCase } from '../src/core/period/application/close-fy.use-case';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { NoopAuditService } from '../src/core/audit/infrastructure/noop-audit.service';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { PeriodFyLockedError, PeriodAlreadyOpenError } from '../src/core/period/domain/errors';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c9';
const FY1 = '00000000-0000-0000-0000-0000000000f9';
const ADMIN_USER = '00000000-0000-0000-0000-0000000000a9';
const PM_USER = '00000000-0000-0000-0000-0000000000a8';

const adminActor: Actor = {
  userId: ADMIN_USER, companyId: CO, financialYearId: FY1,
  role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pmActor: Actor = {
  userId: PM_USER, companyId: CO, financialYearId: FY1,
  role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [], approvalLimit: null,
};

describe('per-fy-lock-error — full reopen evaluation order (real Postgres + real RolesGuard)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let uow: TypeOrmUnitOfWork;
  let generate: GeneratePeriodsUseCase;
  let closePeriod: ClosePeriodUseCase;
  let reopenPeriod: ReopenPeriodUseCase;
  let closeFy: CloseFyUseCase;
  let rolesGuard: RolesGuard;

  const periodIdOwning = async (date: string): Promise<string> => {
    const [row] = await dataSource.query(
      `SELECT id FROM accounting_period WHERE company_id=$1 AND financial_year_id=$2 AND start_date<=$3 AND end_date>=$3`,
      [CO, FY1, date],
    );
    return row.id;
  };

  function mockContext(actor: Actor): ExecutionContext {
    return {
      getHandler: () => function reopen() {},
      getClass: () => class PeriodController {},
      switchToHttp: () => ({ getRequest: () => ({ user: actor }) }),
    } as unknown as ExecutionContext;
  }

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
      entities: [CompanyOrmEntity, FinancialYearOrmEntity, AccountingPeriodOrmEntity, RoleOrmEntity, PermissionOrmEntity],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
        CreateUser1700000700000,
        CreateRbacAndAudit1700000800000,
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

    // Seed ADMIN role WITH {PER, UPDATE} and PROJECT_MANAGER role WITHOUT any PER permission
    // (mirrors seed-roles-permissions.ts: ADMIN gets every module x action; PM does not include PER).
    const adminRoleId = '00000000-0000-0000-0000-0000000000aa';
    const pmRoleId = '00000000-0000-0000-0000-0000000000ab';
    await dataSource.query(
      `INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ADMIN',true,1)`,
      [adminRoleId, CO],
    );
    await dataSource.query(
      `INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1)`,
      [pmRoleId, CO],
    );
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version)
       VALUES (gen_random_uuid(), $1, $2, 'PER', 'UPDATE', 'ALL', 1)`,
      [adminRoleId, CO],
    );
    // PM gets an unrelated permission only — proves the guard checks the SPECIFIC (module,action), not "any permission".
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version)
       VALUES (gen_random_uuid(), $1, $2, 'MAS', 'READ', 'ASSIGNED', 1)`,
      [pmRoleId, CO],
    );

    const repo = new TypeOrmAccountingPeriodRepository(dataSource);
    uow = new TypeOrmUnitOfWork(dataSource);
    const audit = new NoopAuditService();
    const ids = new UuidIdGenerator();
    generate = new GeneratePeriodsUseCase(repo, uow, ids);
    closePeriod = new ClosePeriodUseCase(repo, audit, uow, { now: () => new Date('2026-07-15T10:00:00Z') });
    reopenPeriod = new ReopenPeriodUseCase(repo, audit, uow);
    closeFy = new CloseFyUseCase(repo, audit, uow, { now: () => new Date('2026-07-15T10:00:00Z') });

    const roleRepo = new TypeOrmRoleRepository(dataSource);
    const permRepo = new TypeOrmPermissionRepository(dataSource);
    rolesGuard = new RolesGuard(new Reflector(), roleRepo, permRepo);
    jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue([{ module: 'PER', action: 'UPDATE' }]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  it('AC3: a caller WITHOUT period.reopen gets FORBIDDEN before any use-case/state logic runs', async () => {
    await generate.execute(FY1, adminActor);
    const julId = await periodIdOwning('2025-07-15');

    // The guard rejects before the use case is ever invoked — assert on the guard alone.
    await expect(rolesGuard.canActivate(mockContext(pmActor))).rejects.toBeInstanceOf(ForbiddenException);

    // Prove no state changed as a side-effect of the (rejected) attempt.
    const [{ status }] = await dataSource.query(`SELECT status FROM accounting_period WHERE id=$1`, [julId]);
    expect(status).toBe('OPEN');
  });

  it('AC2 + AC1: a caller WITH period.reopen still gets PERIOD_FY_LOCKED once the FY is closed (state checked after permission)', async () => {
    // Guard passes for ADMIN (holds {PER, UPDATE}) ...
    await expect(rolesGuard.canActivate(mockContext(adminActor))).resolves.toBe(true);

    // ... but close-fy then locks the FY, and the use case itself rejects the state.
    await closeFy.execute(FY1, adminActor);
    const julId = await periodIdOwning('2025-07-15');
    await expect(reopenPeriod.execute(julId, adminActor)).rejects.toBeInstanceOf(PeriodFyLockedError);

    // No partial state change on the reject path.
    const [{ status, closed_at }] = await dataSource.query(
      `SELECT status, closed_at FROM accounting_period WHERE id=$1`, [julId],
    );
    expect(status).toBe('CLOSED');
    expect(closed_at).not.toBeNull();
  });

  it('AC4: normal reopen (FY not fully closed) is unaffected — succeeds, clears stamps', async () => {
    await dataSource.query(`TRUNCATE accounting_period`);
    await generate.execute(FY1, adminActor);
    const augId = await periodIdOwning('2025-08-15');

    await expect(rolesGuard.canActivate(mockContext(adminActor))).resolves.toBe(true);
    await closePeriod.execute(augId, adminActor);
    const reopened = await reopenPeriod.execute(augId, adminActor); // 11 siblings still OPEN -> not year-locked

    expect(reopened.isOpen()).toBe(true);
    const [{ status, closed_at, closed_by }] = await dataSource.query(
      `SELECT status, closed_at, closed_by FROM accounting_period WHERE id=$1`, [augId],
    );
    expect(status).toBe('OPEN');
    expect(closed_at).toBeNull();
    expect(closed_by).toBeNull();
  });

  it('FSM vs year-lock never collide: reopening an already-OPEN period is PERIOD_ALREADY_OPEN, not PERIOD_FY_LOCKED', async () => {
    await dataSource.query(`TRUNCATE accounting_period`);
    const created = await generate.execute(FY1, adminActor);
    await expect(reopenPeriod.execute(created[0].id, adminActor)).rejects.toBeInstanceOf(PeriodAlreadyOpenError);
  });
});
