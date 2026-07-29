/**
 * aud-rbac-v2 (#37) — resource-level permissions + custom roles (FR-AUD-034/035), real Postgres.
 *
 * Covers the brief's headline acceptance criteria:
 *   - FR-AUD-035 resource-split: a role holding `cost_control.budget_vs_actual:READ` but NOT
 *     `cost_control.profitability:READ` passes the Budget guard and is 403 on Profitability (no
 *     sibling-screen leakage). Plus the Resource Catalogue endpoint + out-of-catalogue VALIDATION_ERROR.
 *   - FR-AUD-034 custom-role CRUD: create / rename / delete custom roles; DUPLICATE_ROLE_NAME,
 *     SYSTEM_ROLE_IMMUTABLE (built-in rename/delete), ROLE_IN_USE (delete of an assigned role).
 *   - Rename: the seed produces ACCOUNTS_MANAGER (no ACCOUNTS_TEAM) with is_system=true.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';
import { UserOrmEntity } from '../src/core/auth/infrastructure/user.orm-entity';
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
import { RoleUseCases, PermissionUseCases } from '../src/core/auth/application/rbac.use-cases';
import { PermissionsQueryService } from '../src/core/auth/read/permissions.query-service';
import { RolesQueryService } from '../src/core/auth/read/roles.query-service';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { NoopAuditService } from '../src/core/audit/infrastructure/noop-audit.service';
import { seedRolesPermissions } from '../src/database/seeds/seed-roles-permissions';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000ab201';
const FY = '00000000-0000-0000-0000-0000000ab2f1';
const ADMIN_USER = '00000000-0000-0000-0000-0000000ab2a1';

const adminActor: Actor = {
  userId: ADMIN_USER, companyId: CO, financialYearId: FY,
  role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};

describe('aud-rbac-v2 (#37) — resource-level permissions + custom roles (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let roleRepo: TypeOrmRoleRepository;
  let permRepo: TypeOrmPermissionRepository;
  let rolesGuard: RolesGuard;
  let roleUseCases: RoleUseCases;
  let permissionUseCases: PermissionUseCases;
  let permQuery: PermissionsQueryService;
  let rolesQuery: RolesQueryService;

  function mockContext(actor: Actor | undefined, resource: string, action: string): ExecutionContext {
    jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue([{ resource, action }]);
    return {
      getHandler: () => function handler() {},
      getClass: () => class SomeController {},
      switchToHttp: () => ({ getRequest: () => ({ user: actor, headers: {} }) }),
    } as unknown as ExecutionContext;
  }

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
      entities: [RoleOrmEntity, PermissionOrmEntity, UserOrmEntity],
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
    await ds.initialize();
    await ds.runMigrations();

    await ds.query(
      `INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`,
      [CO],
    );
    await ds.query(
      `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`,
      [FY, CO],
    );

    // Seed the six built-in roles at resource level (is_system=true, ACCOUNTS_MANAGER, HR unscoped).
    await seedRolesPermissions(ds, CO);

    roleRepo = new TypeOrmRoleRepository(ds);
    permRepo = new TypeOrmPermissionRepository(ds);
    rolesGuard = new RolesGuard(new Reflector(), roleRepo, permRepo);
    const uow = new TypeOrmUnitOfWork(ds);
    const audit = new NoopAuditService();
    roleUseCases = new RoleUseCases(roleRepo, permRepo, audit, uow);
    permissionUseCases = new PermissionUseCases(roleRepo, permRepo, audit, uow);
    permQuery = new PermissionsQueryService(ds);
    rolesQuery = new RolesQueryService(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(() => jest.restoreAllMocks());

  // ── Rename: no ACCOUNTS_TEAM; ACCOUNTS_MANAGER is_system, HR unscoped ──
  describe('seed rename + built-in flags', () => {
    it('produces ACCOUNTS_MANAGER (is_system=true) and no ACCOUNTS_TEAM', async () => {
      const [team] = await ds.query(`SELECT id FROM "role" WHERE company_id=$1 AND name='ACCOUNTS_TEAM'`, [CO]);
      expect(team).toBeUndefined();
      const [mgr] = await ds.query(`SELECT is_system AS "isSystem" FROM "role" WHERE company_id=$1 AND name='ACCOUNTS_MANAGER'`, [CO]);
      expect(mgr.isSystem).toBe(true);
    });

    it('HR_MANAGER is seeded unscoped (org-wide HR/payroll)', async () => {
      const [hr] = await ds.query(`SELECT is_unscoped AS "isUnscoped" FROM "role" WHERE company_id=$1 AND name='HR_MANAGER'`, [CO]);
      expect(hr.isUnscoped).toBe(true);
    });
  });

  // ── FR-AUD-035: resource-level split (no sibling-screen leakage) ──
  describe('FR-AUD-035 — resource split', () => {
    let splitRoleName: string;

    beforeAll(async () => {
      const role = await roleUseCases.createRole(adminActor, {
        name: 'BUDGET_ONLY',
        isUnscoped: true,
        permissions: [{ resource: 'cost_control.budget_vs_actual', action: 'READ', projectScope: 'ALL' }],
      });
      splitRoleName = role.name;
    });

    it('reaches Budget-vs-actual (has cost_control.budget_vs_actual:READ)', async () => {
      const actor: Actor = { ...adminActor, role: splitRoleName, isUnscoped: true };
      const ctx = mockContext(actor, 'cost_control.budget_vs_actual', 'READ');
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('is 403 on Profitability (lacks cost_control.profitability:READ) — no sibling leakage', async () => {
      const actor: Actor = { ...adminActor, role: splitRoleName, isUnscoped: true };
      const ctx = mockContext(actor, 'cost_control.profitability', 'READ');
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── FR-AUD-035: Resource Catalogue + out-of-catalogue validation ──
  describe('FR-AUD-035 — catalogue + validation', () => {
    it('GET /permissions/catalog returns the grouped catalogue', () => {
      const catalog = permQuery.catalog();
      expect(catalog.modules.length).toBeGreaterThan(10);
      const cc = catalog.modules.find(m => m.module === 'CC');
      expect(cc?.resources.map(r => r.resource)).toEqual(
        expect.arrayContaining(['cost_control.budget_vs_actual', 'cost_control.profitability', 'cost_control.alerts']),
      );
      const ipcs = catalog.modules.flatMap(m => m.resources).find(r => r.resource === 'sales.ipcs');
      expect(ipcs?.actions).toEqual(expect.arrayContaining(['READ', 'CREATE', 'POST', 'CANCEL']));
    });

    // aud-holidays-resource — `Holidays` gets its own resource, sibling of hr.attendance,
    // full CRUD (unlike hr.attendance which has no DELETE) — FR-AUD-035.
    it('GET /permissions/catalog includes hr.holidays under HR with full CRUD actions', () => {
      const catalog = permQuery.catalog();
      const hr = catalog.modules.find(m => m.module === 'HR');
      const holidays = hr?.resources.find(r => r.resource === 'hr.holidays');
      expect(holidays).toBeDefined();
      expect(holidays?.actions).toEqual(expect.arrayContaining(['READ', 'CREATE', 'UPDATE', 'DELETE']));
    });

    it('rejects an out-of-catalogue resource with VALIDATION_ERROR', async () => {
      const [role] = await ds.query(`SELECT id FROM "role" WHERE company_id=$1 AND name='ADMIN'`, [CO]);
      await expect(
        permissionUseCases.createPermission(adminActor, {
          roleId: role.id, resource: 'not.a.real.resource', action: 'READ', projectScope: 'ALL',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an action the resource does not allow with VALIDATION_ERROR', async () => {
      const [role] = await ds.query(`SELECT id FROM "role" WHERE company_id=$1 AND name='ADMIN'`, [CO]);
      // ledger.journal_entries is READ-only; POST is not applicable.
      await expect(
        permissionUseCases.createPermission(adminActor, {
          roleId: role.id, resource: 'ledger.journal_entries', action: 'POST', projectScope: 'ALL',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── aud-holidays-resource: hr.holidays split from hr.attendance (FR-AUD-013/034/035) ──
  describe('hr.holidays — split from hr.attendance, seeded to HR_MANAGER + ADMIN only', () => {
    it('SITE_ENGINEER keeps hr.attendance:READ/CREATE but gets NO hr.holidays grant of any action', async () => {
      const siteEngineerActor: Actor = { ...adminActor, role: 'SITE_ENGINEER', isUnscoped: false };
      await expect(rolesGuard.canActivate(mockContext(siteEngineerActor, 'hr.attendance', 'READ'))).resolves.toBe(true);
      await expect(rolesGuard.canActivate(mockContext(siteEngineerActor, 'hr.attendance', 'CREATE'))).resolves.toBe(true);
      for (const action of ['READ', 'CREATE', 'UPDATE', 'DELETE']) {
        await expect(rolesGuard.canActivate(mockContext(siteEngineerActor, 'hr.holidays', action))).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it('HR_MANAGER holds hr.holidays with all four actions (READ/CREATE/UPDATE/DELETE)', async () => {
      const hrManagerActor: Actor = { ...adminActor, role: 'HR_MANAGER', isUnscoped: true };
      for (const action of ['READ', 'CREATE', 'UPDATE', 'DELETE']) {
        await expect(rolesGuard.canActivate(mockContext(hrManagerActor, 'hr.holidays', action))).resolves.toBe(true);
      }
    });

    it('ADMIN holds hr.holidays automatically (ADMIN_GRANTS is catalogue-derived) with all four actions', async () => {
      for (const action of ['READ', 'CREATE', 'UPDATE', 'DELETE']) {
        await expect(rolesGuard.canActivate(mockContext(adminActor, 'hr.holidays', action))).resolves.toBe(true);
      }
    });

    it('no other built-in role (ACCOUNTS_MANAGER, PROJECT_MANAGER, STORE_KEEPER) holds hr.holidays', async () => {
      for (const role of ['ACCOUNTS_MANAGER', 'PROJECT_MANAGER', 'STORE_KEEPER']) {
        const actor: Actor = { ...adminActor, role, isUnscoped: false };
        await expect(rolesGuard.canActivate(mockContext(actor, 'hr.holidays', 'READ'))).rejects.toBeInstanceOf(ForbiddenException);
      }
    });
  });

  // ── FR-AUD-034: custom-role CRUD ──
  describe('FR-AUD-034 — custom role CRUD', () => {
    it('creates a custom role (is_system=false) and lists it with userCount', async () => {
      const created = await roleUseCases.createRole(adminActor, { name: 'SITE_SUPERVISOR', isUnscoped: false });
      expect(created.isSystem).toBe(false);
      const detail = await rolesQuery.findById(created.id, CO);
      expect(detail?.isSystem).toBe(false);
      expect(detail?.userCount).toBe(0);
    });

    it('rejects a duplicate role name with DUPLICATE_ROLE_NAME', async () => {
      await expect(
        roleUseCases.createRole(adminActor, { name: 'ADMIN', isUnscoped: true }),
      ).rejects.toMatchObject({ message: 'DUPLICATE_ROLE_NAME' });
    });

    it('renames a custom role', async () => {
      const created = await roleUseCases.createRole(adminActor, { name: 'TEMP_ROLE_A', isUnscoped: false });
      const patched = await roleUseCases.patchRole(created.id, adminActor, { name: 'RENAMED_ROLE_A', version: created.version });
      expect(patched.name).toBe('RENAMED_ROLE_A');
    });

    it('rejects renaming a built-in role with SYSTEM_ROLE_IMMUTABLE', async () => {
      const [admin] = await ds.query(`SELECT id, version FROM "role" WHERE company_id=$1 AND name='ADMIN'`, [CO]);
      await expect(
        roleUseCases.patchRole(admin.id, adminActor, { name: 'SUPERADMIN', version: admin.version }),
      ).rejects.toMatchObject({ message: 'SYSTEM_ROLE_IMMUTABLE' });
    });

    it('rejects deleting a built-in role with SYSTEM_ROLE_IMMUTABLE', async () => {
      const [hr] = await ds.query(`SELECT id FROM "role" WHERE company_id=$1 AND name='HR_MANAGER'`, [CO]);
      await expect(roleUseCases.deleteRole(hr.id, adminActor)).rejects.toMatchObject({ message: 'SYSTEM_ROLE_IMMUTABLE' });
    });

    it('deletes a custom role with no users assigned', async () => {
      const created = await roleUseCases.createRole(adminActor, { name: 'TO_DELETE', isUnscoped: false });
      await expect(roleUseCases.deleteRole(created.id, adminActor)).resolves.toBeUndefined();
      const gone = await roleRepo.findById(created.id, CO);
      expect(gone).toBeNull();
    });

    it('rejects deleting a custom role still assigned to a user with ROLE_IN_USE', async () => {
      const created = await roleUseCases.createRole(adminActor, { name: 'IN_USE_ROLE', isUnscoped: false });
      await ds.query(
        `INSERT INTO "user" (id, company_id, financial_year_id, email, password_hash, name, role, is_active, must_change_password, version)
         VALUES (gen_random_uuid(), $1, $2, 'inuse@ze.local', 'x', 'In Use', 'IN_USE_ROLE', true, true, 1)`,
        [CO, FY],
      );
      await expect(roleUseCases.deleteRole(created.id, adminActor)).rejects.toMatchObject({ message: 'ROLE_IN_USE' });
    });
  });
});
