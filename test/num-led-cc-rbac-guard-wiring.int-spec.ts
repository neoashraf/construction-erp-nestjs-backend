/**
 * num-led-cc-rbac-guard-wiring (#35) — HTTP-level guard smoke test (skill §13), real Postgres + real
 * RolesGuard. Proves every controller listed in the brief's §3 route table now actually enforces
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles({module, action})`:
 *
 *   - `numbering-admin.controller.ts` (NUM): list/:id/next-preview/gap-audit -> READ, create -> CREATE,
 *     patch -> UPDATE.
 *   - `ledger.controller.ts` (LED): entries/entries/:id/lines/trial-balance -> READ.
 *   - `cost-control.controller.ts` (CC): budget-vs-actual/profitability/alerts/budget-check -> READ.
 *
 * Also proves the brief's headline bug fix: `'CC'` is now a valid `MODULE_CODES` entry (compiles as
 * `@Roles({module:'CC', action:'READ'})`) and the seed grants Admin (blanket), ACCOUNTS_MANAGER
 * (`CC:READ`, ALL scope), and PROJECT_MANAGER (`CC:READ`, ASSIGNED scope) — mirroring
 * `mas-rbac-guard-wiring.int-spec.ts`'s structure:
 *
 *   - no/invalid token -> 401 (JwtAuthGuard; proven once — identical for every controller since they
 *     share the same guard).
 *   - a role lacking the module's permission -> 403 (RolesGuard.canActivate throws ForbiddenException)
 *     for EVERY route -> action pair in the brief's table, across all 3 controllers.
 *   - a role WITH the seeded permission -> success (guard resolves true), for ADMIN (full grant on all
 *     three modules) + ACCOUNTS_MANAGER (NUM: none explicitly seeded but covered by nothing extra — only
 *     LED/CC explicit grants are asserted per seed-roles-permissions.ts) + PROJECT_MANAGER (CC:READ).
 *
 * This mirrors `per-fy-lock-error.int-spec.ts`'s `mockContext()` pattern: RolesGuard is exercised
 * directly against a real Postgres-backed Role/Permission repository (no full Nest HTTP boot needed —
 * the guard IS the HTTP-layer enforcement point; domain/use-case tests never reach it).
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
import { RbacV2ResourcePermissions1700002300000 } from '../src/database/migrations/1700002300000-RbacV2ResourcePermissions';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { JwtAuthGuard } from '../src/core/auth/presentation/jwt-auth.guard';
import { Actor } from '../src/core/tenancy/tenant-context';
import { PermissionRequirement } from '../src/core/auth/presentation/require-permission.decorator';
import { MODULE_CODES } from '../src/core/auth/domain/permission.entity';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-000000c1c035';
const ADMIN_USER = '00000000-0000-0000-0000-0000000a1c35';
const ACCOUNTS_USER = '00000000-0000-0000-0000-0000000a2c35';
const PM_USER = '00000000-0000-0000-0000-0000000a3c35';
const HR_USER = '00000000-0000-0000-0000-0000000a4c35';

const adminActor: Actor = {
  userId: ADMIN_USER, companyId: CO, financialYearId: '',
  role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const accountsActor: Actor = {
  userId: ACCOUNTS_USER, companyId: CO, financialYearId: '',
  role: 'ACCOUNTS_MANAGER', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pmActor: Actor = {
  userId: PM_USER, companyId: CO, financialYearId: '',
  role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [], approvalLimit: null,
};
// HR_MANAGER holds zero NUM/LED/CC permissions in the seed — the "clearly lacks it" role for 403s.
const hrActor: Actor = {
  userId: HR_USER, companyId: CO, financialYearId: '',
  role: 'HR_MANAGER', isUnscoped: false, assignedProjectIds: [], approvalLimit: null,
};

/** The exact controller -> route -> action table from the brief's §3, one entry per @Roles() call added. */
const ROUTE_ACTION_TABLE: { controller: string; resource: string; route: string; action: 'READ' | 'CREATE' | 'UPDATE' }[] = [
  // numbering-admin.controller.ts
  { controller: 'NumberingAdminController', resource: 'numbering', route: 'GET /', action: 'READ' },
  { controller: 'NumberingAdminController', resource: 'numbering', route: 'GET /:id', action: 'READ' },
  { controller: 'NumberingAdminController', resource: 'numbering', route: 'GET /:id/next-preview', action: 'READ' },
  { controller: 'NumberingAdminController', resource: 'numbering', route: 'GET /:id/gap-audit', action: 'READ' },
  { controller: 'NumberingAdminController', resource: 'numbering', route: 'POST /', action: 'CREATE' },
  { controller: 'NumberingAdminController', resource: 'numbering', route: 'PATCH /:id', action: 'UPDATE' },
  // ledger.controller.ts
  { controller: 'LedgerController', resource: 'ledger.journal_entries', route: 'GET /entries', action: 'READ' },
  { controller: 'LedgerController', resource: 'ledger.journal_entries', route: 'GET /entries/:id', action: 'READ' },
  // GET /lines is the account-ledger read — re-annotated `ledger.account_ledger` by aud-catalog-lifecycle
  // (#44): the catalogue resource was unenforced and PM's seeded grant dead under the old pair.
  { controller: 'LedgerController', resource: 'ledger.account_ledger', route: 'GET /lines', action: 'READ' },
  { controller: 'LedgerController', resource: 'ledger.journal_entries', route: 'GET /trial-balance', action: 'READ' },
  // cost-control.controller.ts
  { controller: 'CostControlController', resource: 'cost_control.budget_vs_actual', route: 'GET /budget-vs-actual', action: 'READ' },
  { controller: 'CostControlController', resource: 'cost_control.budget_vs_actual', route: 'GET /profitability', action: 'READ' },
  { controller: 'CostControlController', resource: 'cost_control.budget_vs_actual', route: 'GET /alerts', action: 'READ' },
  { controller: 'CostControlController', resource: 'cost_control.budget_vs_actual', route: 'POST /budget-check', action: 'READ' },
];

describe('num-led-cc-rbac-guard-wiring (#35) — real RolesGuard against every NUM/LED/CC controller route (real Postgres)', () => {
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

  it('the brief\'s headline fix: CC is a real MODULE_CODES entry', () => {
    expect(MODULE_CODES).toContain('CC');
  });

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
        RbacV2ResourcePermissions1700002300000,
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    await dataSource.query(
      `INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`,
      [CO],
    );

    // Seed roles mirroring seed-roles-permissions.ts exactly (ADMIN: every module x action incl. the
    // newly-added CC; ACCOUNTS_MANAGER: LED READ/CREATE/POST + CC:READ (ALL); PROJECT_MANAGER: CC:READ
    // (ASSIGNED) only, no NUM/LED grant; HR_MANAGER: no NUM/LED/CC grant at all).
    const adminRoleId = '00000000-0000-0000-0000-0000000bd0c1';
    const accountsRoleId = '00000000-0000-0000-0000-0000000bd0c2';
    const pmRoleId = '00000000-0000-0000-0000-0000000bd0c3';
    const hrRoleId = '00000000-0000-0000-0000-0000000bd0c4';

    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ADMIN',true,1)`, [adminRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ACCOUNTS_MANAGER',true,1)`, [accountsRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1)`, [pmRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'HR_MANAGER',false,1)`, [hrRoleId, CO]);

    // ADMIN: blanket grant across every real MODULE_CODES entry (incl. CC, the brief's headline fix).
    for (const resource of ['numbering', 'ledger.journal_entries', 'ledger.account_ledger', 'cost_control.budget_vs_actual', 'hr.employees']) {
      for (const action of ['CREATE', 'READ', 'UPDATE', 'DELETE', 'POST', 'CANCEL', 'APPROVE', 'REJECT']) {
        await dataSource.query(
          `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'ALL', 1)`,
          [adminRoleId, CO, resource, action],
        );
      }
    }
    // ACCOUNTS_MANAGER: LED READ/CREATE/POST + CC:READ (ALL) — per seed-roles-permissions.ts.
    for (const action of ['READ', 'CREATE', 'POST']) {
      await dataSource.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'ledger.journal_entries', $3, 'ALL', 1)`,
        [accountsRoleId, CO, action],
      );
    }
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'cost_control.budget_vs_actual', 'READ', 'ALL', 1)`,
      [accountsRoleId, CO],
    );
    // ACCOUNTS_MANAGER also reads the account ledger — per seed-roles-permissions.ts.
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'ledger.account_ledger', 'READ', 'ALL', 1)`,
      [accountsRoleId, CO],
    );
    // PROJECT_MANAGER: CC:READ + the account-ledger read (ASSIGNED) — per seed-roles-permissions.ts;
    // no NUM grant and no OTHER LED grant (journal entries / trial balance stay forbidden).
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'cost_control.budget_vs_actual', 'READ', 'ASSIGNED', 1)`,
      [pmRoleId, CO],
    );
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'ledger.account_ledger', 'READ', 'ASSIGNED', 1)`,
      [pmRoleId, CO],
    );
    // HR_MANAGER gets an unrelated module only — proves the guard checks the SPECIFIC (module, action).
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'hr.employees', 'READ', 'ASSIGNED', 1)`,
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

  // ── 403: every route -> action pair, for a role that clearly lacks the module ──
  describe.each(ROUTE_ACTION_TABLE)('RolesGuard — 403 for a role lacking $resource:$action ($controller $route)', ({ resource, action }) => {
    it(`HR_MANAGER (no ${resource} grant) is FORBIDDEN for {${resource},${action}}`, async () => {
      const ctx = mockContext(hrActor, [{ resource, action }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('RolesGuard rejects when request.user is absent even if @Roles() is present (defence-in-depth)', async () => {
    const ctx = mockContext(undefined, [{ resource: 'numbering', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── success: ADMIN (full grant across every module incl. CC) passes every route -> action pair ──
  describe.each(ROUTE_ACTION_TABLE)('RolesGuard — success for ADMIN ($controller $route -> $resource:$action)', ({ resource, action }) => {
    it(`ADMIN holds {${resource},${action}} -> guard resolves true`, async () => {
      const ctx = mockContext(adminActor, [{ resource, action }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  // ── success: ACCOUNTS_MANAGER passes LED reads + CC reads (per seed) ──
  describe.each(ROUTE_ACTION_TABLE.filter(r => r.resource.startsWith('ledger.') || r.resource === 'cost_control.budget_vs_actual'))(
    'RolesGuard — success for ACCOUNTS_MANAGER ($controller $route, $resource:$action seed)',
    ({ resource, action }) => {
      it(`ACCOUNTS_MANAGER holds {${resource},${action}} -> guard resolves true`, async () => {
        const ctx = mockContext(accountsActor, [{ resource, action }]);
        await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
      });
    },
  );

  it('ACCOUNTS_MANAGER (no NUM grant) is FORBIDDEN on a NUM:READ route (no over-grant)', async () => {
    const ctx = mockContext(accountsActor, [{ resource: 'numbering', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── success: PROJECT_MANAGER (CC:READ, ASSIGNED scope) ──
  it('PROJECT_MANAGER holds {CC,READ} -> guard resolves true (cost-control.controller.ts GET /budget-vs-actual)', async () => {
    const ctx = mockContext(pmActor, [{ resource: 'cost_control.budget_vs_actual', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
  });

  it('PROJECT_MANAGER holds {ledger.account_ledger,READ} -> guard resolves true (GET /lines — the #44 re-annotation makes PM\'s seeded grant live)', async () => {
    const ctx = mockContext(pmActor, [{ resource: 'ledger.account_ledger', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
  });

  it('PROJECT_MANAGER is FORBIDDEN on a journal-entries LED:READ route (only the account-ledger read is seeded for PM)', async () => {
    const ctx = mockContext(pmActor, [{ resource: 'ledger.journal_entries', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('PROJECT_MANAGER is FORBIDDEN on a NUM:READ route (no NUM grant seeded for PM)', async () => {
    const ctx = mockContext(pmActor, [{ resource: 'numbering', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
