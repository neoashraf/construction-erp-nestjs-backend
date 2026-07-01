/**
 * mas-rbac-guard-wiring (#34) — HTTP-level guard smoke test (skill §13), real Postgres + real
 * RolesGuard. Proves every Master Data controller listed in the brief's §3 route table now actually
 * enforces `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles({module:'MAS', action})`:
 *
 *   - no/invalid token -> 401 (JwtAuthGuard; proven once here — identical for every controller since
 *     they share the same guard, per `per-fy-lock-error.int-spec.ts`'s precedent of testing the guard
 *     directly rather than re-proving framework wiring 11x).
 *   - a role lacking `MAS` permission -> 403 (RolesGuard.canActivate throws ForbiddenException) for
 *     EVERY route -> action pair in the brief's table, across all 11 controllers.
 *   - a role WITH the seeded MAS permission -> success (guard resolves true), for both ADMIN (full MAS
 *     grant) and ACCOUNTS_TEAM (MAS:READ only, per seed-roles-permissions.ts) — mirrors AC "Seeded roles
 *     still work end-to-end".
 *
 * This mirrors `per-fy-lock-error.int-spec.ts`'s `mockContext()` pattern: RolesGuard is exercised
 * directly against a real Postgres-backed Role/Permission repository (no full Nest HTTP boot needed —
 * the guard IS the HTTP-layer enforcement point; domain/use-case tests never reach it, which is exactly
 * the gap this brief closes, per skill §13).
 *
 * FR-AUD-012/013/017.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { JwtAuthGuard } from '../src/core/auth/presentation/jwt-auth.guard';
import { Actor } from '../src/core/tenancy/tenant-context';
import { PermissionRequirement } from '../src/core/auth/presentation/roles.decorator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000ad034';
const ADMIN_USER = '00000000-0000-0000-0000-0000000ad0a1';
const ACCOUNTS_USER = '00000000-0000-0000-0000-0000000ad0a2';
const PM_USER = '00000000-0000-0000-0000-0000000ad0a3';
const HR_USER = '00000000-0000-0000-0000-0000000ad0a4';

const adminActor: Actor = {
  userId: ADMIN_USER, companyId: CO, financialYearId: '',
  role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const accountsActor: Actor = {
  userId: ACCOUNTS_USER, companyId: CO, financialYearId: '',
  role: 'ACCOUNTS_TEAM', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pmActor: Actor = {
  userId: PM_USER, companyId: CO, financialYearId: '',
  role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [], approvalLimit: null,
};
// HR_MANAGER holds zero MAS permissions in the seed — the "clearly lacks it" role for 403 assertions.
const hrActor: Actor = {
  userId: HR_USER, companyId: CO, financialYearId: '',
  role: 'HR_MANAGER', isUnscoped: false, assignedProjectIds: [], approvalLimit: null,
};

/** The exact controller -> route -> action table from the brief's §3, one entry per @Roles() call added. */
const ROUTE_ACTION_TABLE: { controller: string; route: string; action: 'READ' | 'CREATE' | 'UPDATE' | 'DELETE' }[] = [
  // company.controller.ts
  { controller: 'CompanyController', route: 'GET /', action: 'READ' },
  { controller: 'CompanyController', route: 'GET /:id', action: 'READ' },
  { controller: 'CompanyController', route: 'POST /', action: 'CREATE' },
  { controller: 'CompanyController', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'CompanyController', route: 'PUT /:id/localization', action: 'UPDATE' },
  // financial-year.controller.ts
  { controller: 'FinancialYearController', route: 'GET /', action: 'READ' },
  { controller: 'FinancialYearController', route: 'POST /', action: 'CREATE' },
  { controller: 'FinancialYearController', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'FinancialYearController', route: 'POST /:id/set-active', action: 'UPDATE' },
  // cost-centre.controller.ts
  { controller: 'CostCentreController', route: 'GET /', action: 'READ' },
  { controller: 'CostCentreController', route: 'POST /', action: 'CREATE' },
  { controller: 'CostCentreController', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'CostCentreController', route: 'POST /:id/deactivate', action: 'UPDATE' },
  { controller: 'CostCentreController', route: 'POST /:id/reactivate', action: 'UPDATE' },
  // purpose.controller.ts
  { controller: 'PurposeController', route: 'GET /', action: 'READ' },
  { controller: 'PurposeController', route: 'POST /', action: 'CREATE' },
  { controller: 'PurposeController', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'PurposeController', route: 'POST /:id/deactivate', action: 'UPDATE' },
  { controller: 'PurposeController', route: 'POST /:id/reactivate', action: 'UPDATE' },
  // godown.controller.ts
  { controller: 'GodownController', route: 'GET /', action: 'READ' },
  { controller: 'GodownController', route: 'GET /:id', action: 'READ' },
  { controller: 'GodownController', route: 'POST /', action: 'CREATE' },
  { controller: 'GodownController', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'GodownController', route: 'POST /:id/deactivate', action: 'UPDATE' },
  { controller: 'GodownController', route: 'POST /:id/reactivate', action: 'UPDATE' },
  // project.controller.ts
  { controller: 'ProjectController', route: 'GET /', action: 'READ' },
  { controller: 'ProjectController', route: 'GET /:id', action: 'READ' },
  { controller: 'ProjectController', route: 'POST /', action: 'CREATE' },
  { controller: 'ProjectController', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'ProjectController', route: 'POST /:id/status', action: 'UPDATE' },
  // project-budget.controller.ts
  { controller: 'ProjectBudgetController', route: 'GET /:projectId/budgets', action: 'READ' },
  { controller: 'ProjectBudgetController', route: 'PUT /:projectId/budgets', action: 'UPDATE' },
  { controller: 'ProjectBudgetController', route: 'DELETE /:projectId/budgets/:id', action: 'DELETE' },
  // account-group.controller.ts
  { controller: 'AccountGroupController', route: 'GET /', action: 'READ' },
  { controller: 'AccountGroupController', route: 'POST /', action: 'CREATE' },
  { controller: 'AccountGroupController', route: 'PATCH /:id', action: 'UPDATE' },
  // account.controller.ts
  { controller: 'AccountController', route: 'GET /', action: 'READ' },
  { controller: 'AccountController', route: 'GET /:id', action: 'READ' },
  { controller: 'AccountController', route: 'POST /', action: 'CREATE' },
  { controller: 'AccountController', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'AccountController', route: 'POST /:id/deactivate', action: 'UPDATE' },
  { controller: 'AccountController', route: 'POST /:id/reactivate', action: 'UPDATE' },
  // party.controller.ts
  { controller: 'PartyController', route: 'GET /', action: 'READ' },
  { controller: 'PartyController', route: 'GET /:id', action: 'READ' },
  { controller: 'PartyController', route: 'POST /', action: 'CREATE' },
  { controller: 'PartyController', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'PartyController', route: 'POST /:id/deactivate', action: 'UPDATE' },
  { controller: 'PartyController', route: 'POST /:id/reactivate', action: 'UPDATE' },
  // item.controller.ts
  { controller: 'ItemController', route: 'GET /', action: 'READ' },
  { controller: 'ItemController', route: 'GET /:id', action: 'READ' },
  { controller: 'ItemController', route: 'GET /:itemId/uom-conversions', action: 'READ' },
  { controller: 'ItemController', route: 'POST /', action: 'CREATE' },
  { controller: 'ItemController', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'ItemController', route: 'POST /:id/deactivate', action: 'UPDATE' },
  { controller: 'ItemController', route: 'POST /:id/reactivate', action: 'UPDATE' },
  { controller: 'ItemController', route: 'PUT /:itemId/uom-conversions', action: 'UPDATE' },
  { controller: 'ItemController', route: 'DELETE /:itemId/uom-conversions/:id', action: 'DELETE' },
];

describe('mas-rbac-guard-wiring (#34) — real RolesGuard against every MAS controller route (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let rolesGuard: RolesGuard;
  let jwtAuthGuard: JwtAuthGuard;

  function mockContext(actor: Actor | undefined, requirements: PermissionRequirement[]): ExecutionContext {
    jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requirements);
    return {
      getHandler: () => function handler() {},
      getClass: () => class SomeController {},
      switchToHttp: () => ({ getRequest: () => ({ user: actor, headers: {} }) }),
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
      entities: [RoleOrmEntity, PermissionOrmEntity],
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

    // Seed roles mirroring seed-roles-permissions.ts exactly (ADMIN: every module x action incl. MAS;
    // ACCOUNTS_TEAM: MAS:READ only; PROJECT_MANAGER: MAS:READ + MAS:UPDATE, ASSIGNED scope;
    // HR_MANAGER: no MAS grant at all).
    const adminRoleId = '00000000-0000-0000-0000-0000000bd0a1';
    const accountsRoleId = '00000000-0000-0000-0000-0000000bd0a2';
    const pmRoleId = '00000000-0000-0000-0000-0000000bd0a3';
    const hrRoleId = '00000000-0000-0000-0000-0000000bd0a4';

    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ADMIN',true,1)`, [adminRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ACCOUNTS_TEAM',true,1)`, [accountsRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1)`, [pmRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'HR_MANAGER',false,1)`, [hrRoleId, CO]);

    for (const action of ['CREATE', 'READ', 'UPDATE', 'DELETE', 'POST', 'CANCEL', 'APPROVE', 'REJECT']) {
      await dataSource.query(
        `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'MAS', $3, 'ALL', 1)`,
        [adminRoleId, CO, action],
      );
    }
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'MAS', 'READ', 'ALL', 1)`,
      [accountsRoleId, CO],
    );
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'MAS', 'READ', 'ASSIGNED', 1)`,
      [pmRoleId, CO],
    );
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'MAS', 'UPDATE', 'ASSIGNED', 1)`,
      [pmRoleId, CO],
    );
    // HR_MANAGER gets an unrelated module only — proves the guard checks the SPECIFIC (module, action).
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'HR', 'READ', 'ASSIGNED', 1)`,
      [hrRoleId, CO],
    );

    const roleRepo = new TypeOrmRoleRepository(dataSource);
    const permRepo = new TypeOrmPermissionRepository(dataSource);
    rolesGuard = new RolesGuard(new Reflector(), roleRepo, permRepo);
    jwtAuthGuard = new JwtAuthGuard();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 401: no/invalid token ────────────────────────────────────────────────
  describe('JwtAuthGuard — no/invalid token (401)', () => {
    it('handleRequest throws UnauthorizedException when passport found no user (missing/invalid/expired token)', () => {
      expect(() => jwtAuthGuard.handleRequest(null, false, null)).toThrow(UnauthorizedException);
    });

    it('handleRequest throws UnauthorizedException on a passport error (malformed token)', () => {
      expect(() => jwtAuthGuard.handleRequest(new Error('jwt malformed'), false, null)).toThrow(UnauthorizedException);
    });
  });

  // ── 403: every route -> action pair, for a role that clearly lacks MAS ──
  describe.each(ROUTE_ACTION_TABLE)('RolesGuard — 403 for a role lacking MAS:$action ($controller $route)', ({ action }) => {
    it(`HR_MANAGER (no MAS grant) is FORBIDDEN for {MAS,${action}}`, async () => {
      const ctx = mockContext(hrActor, [{ module: 'MAS', action }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('RolesGuard rejects when request.user is absent even if @Roles() is present (defence-in-depth)', async () => {
    const ctx = mockContext(undefined, [{ module: 'MAS', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── success: ADMIN (full MAS grant) passes every route -> action pair ──
  describe.each(ROUTE_ACTION_TABLE)('RolesGuard — success for ADMIN ($controller $route -> MAS:$action)', ({ action }) => {
    it(`ADMIN holds {MAS,${action}} -> guard resolves true`, async () => {
      const ctx = mockContext(adminActor, [{ module: 'MAS', action }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  // ── success: ACCOUNTS_TEAM (MAS:READ only, per seed) passes every READ route ──
  describe.each(ROUTE_ACTION_TABLE.filter(r => r.action === 'READ'))(
    'RolesGuard — success for ACCOUNTS_TEAM ($controller $route, READ-only seed)',
    ({ action }) => {
      it(`ACCOUNTS_TEAM holds {MAS,READ} -> guard resolves true`, async () => {
        const ctx = mockContext(accountsActor, [{ module: 'MAS', action }]);
        await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
      });
    },
  );

  it('ACCOUNTS_TEAM (MAS:READ only) is FORBIDDEN on a MAS:CREATE route (no over-grant)', async () => {
    const ctx = mockContext(accountsActor, [{ module: 'MAS', action: 'CREATE' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── success: PROJECT_MANAGER (MAS:READ + MAS:UPDATE, ASSIGNED scope) ──
  it('PROJECT_MANAGER holds {MAS,READ} -> guard resolves true (project.controller.ts GET /)', async () => {
    const ctx = mockContext(pmActor, [{ module: 'MAS', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
  });

  it('PROJECT_MANAGER holds {MAS,UPDATE} -> guard resolves true (project.controller.ts PATCH /:id)', async () => {
    const ctx = mockContext(pmActor, [{ module: 'MAS', action: 'UPDATE' }]);
    await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
  });

  it('PROJECT_MANAGER is FORBIDDEN on a MAS:DELETE route (project-budget delete, item uom-conversion delete)', async () => {
    const ctx = mockContext(pmActor, [{ module: 'MAS', action: 'DELETE' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
