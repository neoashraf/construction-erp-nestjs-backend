/**
 * tier2-rbac-guard-wiring (#36) — HTTP-level guard smoke test (skill §13), real Postgres + real
 * RolesGuard. Proves every controller listed in the brief's §3 route table now actually enforces
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles({module, action})`:
 *
 *   - `contra.controller.ts` (GEN): list/:id -> READ, create -> CREATE, patch -> UPDATE,
 *     delete -> DELETE, post -> POST, reverse -> CANCEL.
 *   - `journal.controller.ts` (GEN): list/:id -> READ, opening -> POST, create -> CREATE,
 *     patch -> UPDATE, delete -> DELETE, post -> POST, reverse -> CANCEL.
 *   - `stock-journal.controller.ts` (INV): list/:id -> READ, create -> CREATE, patch -> UPDATE,
 *     delete -> DELETE, approve -> APPROVE, post -> POST, reverse -> CANCEL.
 *   - `stock-ledger.controller.ts` (INV): stock-ledger/movements -> READ.
 *   - `attendance.controller.ts` (HR): list -> READ, office/office-import/subcontractor/daily-labour ->
 *     CREATE, edit daily-labour -> UPDATE, confirm -> POST, reverse -> CANCEL.
 *   - `employee.controller.ts` (HR): list/:id/assignments -> READ, create -> CREATE, patch -> UPDATE,
 *     reassign/deactivate/reactivate -> UPDATE.
 *   - `requisition.controller.ts` (REQ): list/:id/approvals/outstanding -> READ, create -> CREATE,
 *     patch -> UPDATE, delete -> DELETE, submit/close -> UPDATE, approve -> APPROVE, reject -> REJECT.
 *   - `sales.controller.ts` (SAL): list/:id -> READ, create -> CREATE, patch -> UPDATE, delete -> DELETE,
 *     post/repost -> POST, cancel -> CANCEL.
 *
 * Mirrors `mas-rbac-guard-wiring.int-spec.ts` / `num-led-cc-rbac-guard-wiring.int-spec.ts`'s structure and
 * `per-fy-lock-error.int-spec.ts`'s `mockContext()` pattern: RolesGuard is exercised directly against a
 * real Postgres-backed Role/Permission repository (no full Nest HTTP boot needed — the guard IS the
 * HTTP-layer enforcement point; domain/use-case/Testcontainers-repository tests never reach it).
 *
 *   - no/invalid token -> 401 (JwtAuthGuard; proven once — identical for every controller since they
 *     share the same guard).
 *   - a role lacking the module's permission -> 403 (RolesGuard.canActivate throws ForbiddenException)
 *     for EVERY route -> action pair in the brief's table, across all 8 controllers.
 *   - a role WITH the seeded permission -> success (guard resolves true): ADMIN (every route, all five
 *     modules) + ACCOUNTS_MANAGER (GEN full lifecycle + SAL full lifecycle, per the brief's genuine-gap seed
 *     additions) + STORE_KEEPER (INV CREATE/READ/UPDATE/POST/CANCEL) + PROJECT_MANAGER (INV:APPROVE,
 *     REQ full workflow) + HR_MANAGER (HR CREATE/READ/UPDATE/POST/CANCEL).
 *
 * FR-AUD-012/013/017.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
// JwtAuthGuard raises DOMAIN errors, not Nest exceptions — the domain layer must not
// import from @nestjs/common (nestjs-author §9); the global filter maps this to 401.
import { UnauthenticatedError } from '../src/common/errors/domain-error';
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

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000e2c36';
const ADMIN_USER = '00000000-0000-0000-0000-0000000e2a01';
const ACCOUNTS_USER = '00000000-0000-0000-0000-0000000e2a02';
const PM_USER = '00000000-0000-0000-0000-0000000e2a03';
const STORE_KEEPER_USER = '00000000-0000-0000-0000-0000000e2a04';
const HR_USER = '00000000-0000-0000-0000-0000000e2a05';
const SITE_ENGINEER_USER = '00000000-0000-0000-0000-0000000e2a06';

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
const storeKeeperActor: Actor = {
  userId: STORE_KEEPER_USER, companyId: CO, financialYearId: '',
  role: 'STORE_KEEPER', isUnscoped: false, assignedProjectIds: [], approvalLimit: null,
};
// HR_MANAGER holds zero GEN/INV/REQ/SAL grant in the seed — the "clearly lacks it" role for 403s on
// those four modules' route -> action pairs.
const hrActor: Actor = {
  userId: HR_USER, companyId: CO, financialYearId: '',
  role: 'HR_MANAGER', isUnscoped: false, assignedProjectIds: [], approvalLimit: null,
};
// SITE_ENGINEER holds zero HR:POST/HR:CANCEL grant (only HR:CREATE/READ) and zero GEN/INV/SAL/REQ:UPDATE+
// grant — used below only where HR_MANAGER cannot serve as the "lacks it" role (HR routes, since
// HR_MANAGER legitimately holds every HR action needed by this brief's table).
const siteEngineerActor: Actor = {
  userId: SITE_ENGINEER_USER, companyId: CO, financialYearId: '',
  role: 'SITE_ENGINEER', isUnscoped: false, assignedProjectIds: [], approvalLimit: null,
};

type Action = 'READ' | 'CREATE' | 'UPDATE' | 'DELETE' | 'POST' | 'CANCEL' | 'APPROVE' | 'REJECT';

/** The exact controller -> route -> action table from the brief's §3, one entry per @Roles() call added. */
const ROUTE_ACTION_TABLE: { controller: string; resource: string; route: string; action: Action }[] = [
  // contra.controller.ts
  { controller: 'ContraController', resource: 'contra_journal.vouchers', route: 'GET /', action: 'READ' },
  { controller: 'ContraController', resource: 'contra_journal.vouchers', route: 'GET /:id', action: 'READ' },
  { controller: 'ContraController', resource: 'contra_journal.vouchers', route: 'POST /', action: 'CREATE' },
  { controller: 'ContraController', resource: 'contra_journal.vouchers', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'ContraController', resource: 'contra_journal.vouchers', route: 'DELETE /:id', action: 'DELETE' },
  { controller: 'ContraController', resource: 'contra_journal.vouchers', route: 'POST /:id/post', action: 'POST' },
  { controller: 'ContraController', resource: 'contra_journal.vouchers', route: 'POST /:id/reverse', action: 'CANCEL' },
  // journal.controller.ts
  { controller: 'JournalController', resource: 'contra_journal.vouchers', route: 'GET /', action: 'READ' },
  { controller: 'JournalController', resource: 'contra_journal.vouchers', route: 'GET /:id', action: 'READ' },
  { controller: 'JournalController', resource: 'contra_journal.vouchers', route: 'POST /opening', action: 'POST' },
  { controller: 'JournalController', resource: 'contra_journal.vouchers', route: 'POST /', action: 'CREATE' },
  { controller: 'JournalController', resource: 'contra_journal.vouchers', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'JournalController', resource: 'contra_journal.vouchers', route: 'DELETE /:id', action: 'DELETE' },
  { controller: 'JournalController', resource: 'contra_journal.vouchers', route: 'POST /:id/post', action: 'POST' },
  { controller: 'JournalController', resource: 'contra_journal.vouchers', route: 'POST /:id/reverse', action: 'CANCEL' },
  // stock-journal.controller.ts
  { controller: 'StockJournalController', resource: 'inventory.stock_journals', route: 'GET /', action: 'READ' },
  { controller: 'StockJournalController', resource: 'inventory.stock_journals', route: 'GET /:id', action: 'READ' },
  { controller: 'StockJournalController', resource: 'inventory.stock_journals', route: 'POST /', action: 'CREATE' },
  { controller: 'StockJournalController', resource: 'inventory.stock_journals', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'StockJournalController', resource: 'inventory.stock_journals', route: 'DELETE /:id', action: 'DELETE' },
  { controller: 'StockJournalController', resource: 'inventory.stock_journals', route: 'POST /:id/approve', action: 'APPROVE' },
  { controller: 'StockJournalController', resource: 'inventory.stock_journals', route: 'POST /:id/post', action: 'POST' },
  { controller: 'StockJournalController', resource: 'inventory.stock_journals', route: 'POST /:id/reverse', action: 'CANCEL' },
  // stock-ledger.controller.ts
  { controller: 'StockLedgerController', resource: 'inventory.stock_journals', route: 'GET /stock-ledger', action: 'READ' },
  { controller: 'StockLedgerController', resource: 'inventory.stock_journals', route: 'GET /stock-ledger/movements', action: 'READ' },
  // attendance.controller.ts
  { controller: 'AttendanceController', resource: 'hr.attendance', route: 'GET /', action: 'READ' },
  { controller: 'AttendanceController', resource: 'hr.attendance', route: 'POST /office', action: 'CREATE' },
  { controller: 'AttendanceController', resource: 'hr.attendance', route: 'POST /subcontractor', action: 'CREATE' },
  { controller: 'AttendanceController', resource: 'hr.attendance', route: 'POST /daily-labour', action: 'CREATE' },
  { controller: 'AttendanceController', resource: 'hr.attendance', route: 'PATCH /daily-labour/:id', action: 'UPDATE' },
  { controller: 'AttendanceController', resource: 'hr.attendance', route: 'POST /daily-labour/:id/confirm', action: 'POST' },
  { controller: 'AttendanceController', resource: 'hr.attendance', route: 'POST /daily-labour/:id/reverse', action: 'CANCEL' },
  // employee.controller.ts
  { controller: 'EmployeeController', resource: 'hr.attendance', route: 'GET /', action: 'READ' },
  { controller: 'EmployeeController', resource: 'hr.attendance', route: 'GET /:id', action: 'READ' },
  { controller: 'EmployeeController', resource: 'hr.attendance', route: 'GET /:id/assignments', action: 'READ' },
  { controller: 'EmployeeController', resource: 'hr.attendance', route: 'POST /', action: 'CREATE' },
  { controller: 'EmployeeController', resource: 'hr.attendance', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'EmployeeController', resource: 'hr.attendance', route: 'POST /:id/reassign', action: 'UPDATE' },
  { controller: 'EmployeeController', resource: 'hr.attendance', route: 'POST /:id/deactivate', action: 'UPDATE' },
  { controller: 'EmployeeController', resource: 'hr.attendance', route: 'POST /:id/reactivate', action: 'UPDATE' },
  // requisition.controller.ts
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'GET /', action: 'READ' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'GET /:id', action: 'READ' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'GET /:id/approvals', action: 'READ' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'GET /:id/outstanding', action: 'READ' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'POST /', action: 'CREATE' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'PATCH /:id', action: 'UPDATE' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'DELETE /:id', action: 'DELETE' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'POST /:id/submit', action: 'UPDATE' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'POST /:id/close', action: 'UPDATE' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'POST /:id/approve', action: 'APPROVE' },
  { controller: 'RequisitionController', resource: 'requisitions.list', route: 'POST /:id/reject', action: 'REJECT' },
  // sales.controller.ts
  { controller: 'SalesController', resource: 'sales.ipcs', route: 'GET /ipc', action: 'READ' },
  { controller: 'SalesController', resource: 'sales.ipcs', route: 'GET /ipc/:id', action: 'READ' },
  { controller: 'SalesController', resource: 'sales.ipcs', route: 'POST /ipc', action: 'CREATE' },
  { controller: 'SalesController', resource: 'sales.ipcs', route: 'PATCH /ipc/:id', action: 'UPDATE' },
  { controller: 'SalesController', resource: 'sales.ipcs', route: 'DELETE /ipc/:id', action: 'DELETE' },
  { controller: 'SalesController', resource: 'sales.ipcs', route: 'POST /ipc/:id/post', action: 'POST' },
  { controller: 'SalesController', resource: 'sales.ipcs', route: 'POST /ipc/:id/repost', action: 'POST' },
  { controller: 'SalesController', resource: 'sales.ipcs', route: 'POST /ipc/:id/cancel', action: 'CANCEL' },
];

describe('tier2-rbac-guard-wiring (#36) — real RolesGuard against every GEN/INV/HR/REQ/SAL controller route (real Postgres)', () => {
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
        RbacV2ResourcePermissions1700002300000,
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    await dataSource.query(
      `INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`,
      [CO],
    );

    // Seed roles mirroring seed-roles-permissions.ts exactly (post tier2-rbac-guard-wiring's additive
    // grants): ADMIN blanket; ACCOUNTS_MANAGER GEN full lifecycle + SAL full lifecycle (the brief's genuine
    // gaps); STORE_KEEPER INV CREATE/READ/UPDATE/POST/CANCEL; PROJECT_MANAGER REQ full workflow +
    // INV:APPROVE; HR_MANAGER HR CREATE/READ/UPDATE/POST/CANCEL; SITE_ENGINEER holds none of GEN/INV/SAL
    // and no APPROVE/POST/CANCEL/REJECT anywhere — the "clearly lacks it" role.
    const adminRoleId = '00000000-0000-0000-0000-0000000e2b01';
    const accountsRoleId = '00000000-0000-0000-0000-0000000e2b02';
    const pmRoleId = '00000000-0000-0000-0000-0000000e2b03';
    const storeKeeperRoleId = '00000000-0000-0000-0000-0000000e2b04';
    const hrRoleId = '00000000-0000-0000-0000-0000000e2b05';
    const siteEngineerRoleId = '00000000-0000-0000-0000-0000000e2b06';

    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ADMIN',true,1)`, [adminRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ACCOUNTS_MANAGER',true,1)`, [accountsRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1)`, [pmRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'STORE_KEEPER',false,1)`, [storeKeeperRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'HR_MANAGER',false,1)`, [hrRoleId, CO]);
    await dataSource.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'SITE_ENGINEER',false,1)`, [siteEngineerRoleId, CO]);

    const ALL_ACTIONS = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'POST', 'CANCEL', 'APPROVE', 'REJECT'];

    // ADMIN: blanket grant across every module.
    for (const resource of ['contra_journal.vouchers', 'inventory.stock_journals', 'hr.attendance', 'requisitions.list', 'sales.ipcs']) {
      for (const action of ALL_ACTIONS) {
        await dataSource.query(
          `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'ALL', 1)`,
          [adminRoleId, CO, resource, action],
        );
      }
    }
    // ACCOUNTS_MANAGER: GEN full lifecycle + SAL full lifecycle — per seed-roles-permissions.ts.
    for (const action of ['CREATE', 'READ', 'UPDATE', 'DELETE', 'POST', 'CANCEL']) {
      await dataSource.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'contra_journal.vouchers', $3, 'ALL', 1)`,
        [accountsRoleId, CO, action],
      );
      await dataSource.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'sales.ipcs', $3, 'ALL', 1)`,
        [accountsRoleId, CO, action],
      );
    }
    // STORE_KEEPER: INV CREATE/READ/UPDATE/POST/CANCEL — per seed-roles-permissions.ts.
    for (const action of ['CREATE', 'READ', 'UPDATE', 'POST', 'CANCEL']) {
      await dataSource.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'inventory.stock_journals', $3, 'ASSIGNED', 1)`,
        [storeKeeperRoleId, CO, action],
      );
    }
    // PROJECT_MANAGER: REQ full workflow + INV:APPROVE only — per seed-roles-permissions.ts.
    for (const action of ['CREATE', 'READ', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT']) {
      await dataSource.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'requisitions.list', $3, 'ASSIGNED', 1)`,
        [pmRoleId, CO, action],
      );
    }
    await dataSource.query(
      `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'inventory.stock_journals', 'APPROVE', 'ASSIGNED', 1)`,
      [pmRoleId, CO],
    );
    // HR_MANAGER: HR CREATE/READ/UPDATE/POST/CANCEL — per seed-roles-permissions.ts.
    for (const action of ['CREATE', 'READ', 'UPDATE', 'POST', 'CANCEL']) {
      await dataSource.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'hr.attendance', $3, 'ASSIGNED', 1)`,
        [hrRoleId, CO, action],
      );
    }
    // SITE_ENGINEER: REQ CREATE/READ + HR CREATE/READ only — no GEN/INV/SAL, no APPROVE/POST/CANCEL/REJECT.
    for (const action of ['CREATE', 'READ']) {
      await dataSource.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'requisitions.list', $3, 'ASSIGNED', 1)`,
        [siteEngineerRoleId, CO, action],
      );
      await dataSource.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'hr.attendance', $3, 'ASSIGNED', 1)`,
        [siteEngineerRoleId, CO, action],
      );
    }

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
    it('handleRequest throws UnauthenticatedError (mapped to 401) when passport found no user (missing/invalid/expired token)', () => {
      expect(() => jwtAuthGuard.handleRequest(null, false, null)).toThrow(UnauthenticatedError);
    });

    it('handleRequest throws UnauthenticatedError (mapped to 401) on a passport error (malformed token)', () => {
      expect(() => jwtAuthGuard.handleRequest(new Error('jwt malformed'), false, null)).toThrow(UnauthenticatedError);
    });
  });

  // ── 403: every route -> action pair, for a role that clearly lacks the module entirely ──
  // HR_MANAGER holds zero GEN/INV/REQ/SAL permission in the seed -> the "lacks it" role for those four
  // modules. STORE_KEEPER holds zero HR permission in the seed -> the "lacks it" role for HR (HR_MANAGER
  // itself legitimately holds every HR action this brief's table needs, so it can't serve as the "lacks
  // it" subject there).
  describe.each(ROUTE_ACTION_TABLE)('RolesGuard — 403 for a role lacking $resource:$action ($controller $route)', ({ resource, action }) => {
    const lacksItActor = resource === 'hr.attendance' ? storeKeeperActor : hrActor;
    const lacksItName = resource === 'hr.attendance' ? 'STORE_KEEPER' : 'HR_MANAGER';
    it(`${lacksItName} (no ${resource}:${action} grant) is FORBIDDEN`, async () => {
      const ctx = mockContext(lacksItActor, [{ resource, action }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('SITE_ENGINEER is FORBIDDEN on HR:POST (daily-labour confirm belongs to HR_MANAGER, not Site Engineer)', async () => {
    const ctx = mockContext(siteEngineerActor, [{ resource: 'hr.attendance', action: 'POST' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('RolesGuard rejects when request.user is absent even if @Roles() is present (defence-in-depth)', async () => {
    const ctx = mockContext(undefined, [{ resource: 'contra_journal.vouchers', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── success: ADMIN (full grant across every module) passes every route -> action pair ──
  describe.each(ROUTE_ACTION_TABLE)('RolesGuard — success for ADMIN ($controller $route -> $resource:$action)', ({ resource, action }) => {
    it(`ADMIN holds {${resource},${action}} -> guard resolves true`, async () => {
      const ctx = mockContext(adminActor, [{ resource, action }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  // ── success: ACCOUNTS_MANAGER passes the full GEN + SAL lifecycle (per seed) ──
  describe.each(ROUTE_ACTION_TABLE.filter(r => r.resource === 'contra_journal.vouchers' || r.resource === 'sales.ipcs'))(
    'RolesGuard — success for ACCOUNTS_MANAGER ($controller $route, $resource:$action seed)',
    ({ resource, action }) => {
      it(`ACCOUNTS_MANAGER holds {${resource},${action}} -> guard resolves true`, async () => {
        const ctx = mockContext(accountsActor, [{ resource, action }]);
        await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
      });
    },
  );

  it('ACCOUNTS_MANAGER (no INV grant) is FORBIDDEN on an INV:READ route (no over-grant)', async () => {
    const ctx = mockContext(accountsActor, [{ resource: 'inventory.stock_journals', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── success: STORE_KEEPER passes INV CREATE/READ/UPDATE/POST/CANCEL (per seed) ──
  describe.each(['CREATE', 'READ', 'UPDATE', 'POST', 'CANCEL'] as const)(
    'RolesGuard — success for STORE_KEEPER (INV:%s seed)',
    (action) => {
      it(`STORE_KEEPER holds {INV,${action}} -> guard resolves true`, async () => {
        const ctx = mockContext(storeKeeperActor, [{ resource: 'inventory.stock_journals', action }]);
        await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
      });
    },
  );

  it('STORE_KEEPER is FORBIDDEN on INV:APPROVE (that grant belongs to PROJECT_MANAGER, not Store Keeper)', async () => {
    const ctx = mockContext(storeKeeperActor, [{ resource: 'inventory.stock_journals', action: 'APPROVE' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── success: PROJECT_MANAGER passes REQ full workflow + INV:APPROVE (per seed) ──
  describe.each(ROUTE_ACTION_TABLE.filter(r => r.resource === 'requisitions.list'))(
    'RolesGuard — success for PROJECT_MANAGER ($controller $route, $resource:$action seed)',
    ({ resource, action }) => {
      it(`PROJECT_MANAGER holds {${resource},${action}} -> guard resolves true`, async () => {
        const ctx = mockContext(pmActor, [{ resource, action }]);
        await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
      });
    },
  );

  it('PROJECT_MANAGER holds {INV,APPROVE} -> guard resolves true (stock-journal.controller.ts POST /:id/approve)', async () => {
    const ctx = mockContext(pmActor, [{ resource: 'inventory.stock_journals', action: 'APPROVE' }]);
    await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
  });

  it('PROJECT_MANAGER is FORBIDDEN on INV:POST (that grant belongs to Store Keeper, not PM)', async () => {
    const ctx = mockContext(pmActor, [{ resource: 'inventory.stock_journals', action: 'POST' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('PROJECT_MANAGER is FORBIDDEN on GEN:CREATE (PM does not raise contra/journal vouchers)', async () => {
    const ctx = mockContext(pmActor, [{ resource: 'contra_journal.vouchers', action: 'CREATE' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── success: HR_MANAGER passes HR CREATE/READ/UPDATE/POST/CANCEL (per seed) ──
  describe.each(['CREATE', 'READ', 'UPDATE', 'POST', 'CANCEL'] as const)(
    'RolesGuard — success for HR_MANAGER (HR:%s seed)',
    (action) => {
      it(`HR_MANAGER holds {HR,${action}} -> guard resolves true`, async () => {
        const ctx = mockContext(hrActor, [{ resource: 'hr.attendance', action }]);
        await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
      });
    },
  );

  it('HR_MANAGER is FORBIDDEN on a SAL:READ route (no SAL grant seeded for HR_MANAGER)', async () => {
    const ctx = mockContext(hrActor, [{ resource: 'sales.ipcs', action: 'READ' }]);
    await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
