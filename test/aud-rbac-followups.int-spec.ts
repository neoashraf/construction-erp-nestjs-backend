/**
 * aud-rbac-followups (#43) — user-read role fields + Admin anti-lockout + batch grid save,
 * real Postgres (Testcontainers).
 *
 * Covers the brief's acceptance criteria:
 *   - FR-AUD-011/015: GET /api/users (+ /:id) expose roleId/roleIsSystem/roleIsUnscoped joined
 *     from `role`; `role` (name) retained; password_hash never present.
 *   - FR-AUD-034 anti-lockout: revoking (DELETE) or narrowing (PATCH) a built-in Admin/superuser
 *     grant is ADMIN_LOCKOUT_FORBIDDEN (409); the same ops on any other role are unaffected.
 *   - FR-AUD-013/019/020/035 batch save: PATCH /api/roles/:id/permissions replaces the grid
 *     atomically under one version check; the audited delta mirrors the diff; catalogue-invalid
 *     pairs / duplicates / ROLE_SCOPE_CONFLICT / Admin lockout reject the WHOLE batch.
 *   - Guard smoke (skill §13): the batch route's (audit.roles, UPDATE) requirement via RolesGuard.
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
import { UsersQueryService } from '../src/core/auth/read/users.query-service';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { seedRolesPermissions } from '../src/database/seeds/seed-roles-permissions';
import { Actor } from '../src/core/tenancy/tenant-context';
import { AuditEntry, AuditService } from '../src/core/audit/application/audit.port';
import { RESOURCE_CATALOG } from '../src/core/auth/domain/resource-catalog';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000f4301';
const FY = '00000000-0000-0000-0000-0000000f43f1';
const ADMIN_USER = '00000000-0000-0000-0000-0000000f43a1';
const PM_USER = '00000000-0000-0000-0000-0000000f43a2';

const adminActor: Actor = {
  userId: ADMIN_USER, companyId: CO, financialYearId: FY,
  role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};

/** Capturing audit fake — asserts the batch save's diff-audit (FR-AUD-020). */
class CapturingAuditService implements AuditService {
  events: AuditEntry[] = [];
  failOn: ((e: AuditEntry) => boolean) | null = null;
  async record(entry: AuditEntry): Promise<void> {
    if (this.failOn?.(entry)) throw new Error('audit failure (test-injected)');
    this.events.push(entry);
  }
  reset() { this.events = []; this.failOn = null; }
  ofType(entityType: string, action?: string) {
    return this.events.filter(e => e.entityType === entityType && (!action || e.action === action));
  }
}

describe('aud-rbac-followups (#43) — role fields + anti-lockout + batch grid save (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let roleRepo: TypeOrmRoleRepository;
  let permRepo: TypeOrmPermissionRepository;
  let rolesGuard: RolesGuard;
  let roleUseCases: RoleUseCases;
  let permissionUseCases: PermissionUseCases;
  let usersQuery: UsersQueryService;
  let audit: CapturingAuditService;

  function mockContext(actor: Actor | undefined, resource: string, action: string): ExecutionContext {
    jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue([{ resource, action }]);
    return {
      getHandler: () => function handler() {},
      getClass: () => class SomeController {},
      switchToHttp: () => ({ getRequest: () => ({ user: actor, headers: {} }) }),
    } as unknown as ExecutionContext;
  }

  async function grid(roleId: string): Promise<Array<{ resource: string; action: string; projectScope: string; valueLimit: string | null }>> {
    return ds.query(
      `SELECT resource, action, project_scope AS "projectScope", value_limit::text AS "valueLimit"
       FROM "permission" WHERE role_id = $1 ORDER BY resource, action`,
      [roleId],
    );
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
    await seedRolesPermissions(ds, CO);

    // Two users for the read-fields criterion: Admin (built-in, unscoped) + a PM (built-in, scoped).
    await ds.query(
      `INSERT INTO "user" (id, company_id, financial_year_id, email, password_hash, name, role, is_active, must_change_password, version)
       VALUES ($1, $2, $3, 'admin@ze.local', 'x', 'Admin', 'ADMIN', true, false, 1),
              ($4, $2, $3, 'pm@ze.local', 'x', 'PM', 'PROJECT_MANAGER', true, false, 1)`,
      [ADMIN_USER, CO, FY, PM_USER],
    );

    roleRepo = new TypeOrmRoleRepository(ds);
    permRepo = new TypeOrmPermissionRepository(ds);
    rolesGuard = new RolesGuard(new Reflector(), roleRepo, permRepo);
    const uow = new TypeOrmUnitOfWork(ds);
    audit = new CapturingAuditService();
    roleUseCases = new RoleUseCases(roleRepo, permRepo, audit, uow);
    permissionUseCases = new PermissionUseCases(roleRepo, permRepo, audit, uow);
    usersQuery = new UsersQueryService(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    audit.reset();
  });

  // ── FR-AUD-011/015: user reads expose roleId / roleIsSystem / roleIsUnscoped ──
  describe('user-read role fields', () => {
    it('findAll joins the role: roleId + roleIsSystem + roleIsUnscoped, role name retained, no password_hash', async () => {
      const { items } = await usersQuery.findAll(CO, { page: 1, pageSize: 25 });
      const admin = items.find((u: any) => u.email === 'admin@ze.local') as any;
      const pm = items.find((u: any) => u.email === 'pm@ze.local') as any;

      const [adminRole] = await ds.query(`SELECT id FROM "role" WHERE company_id=$1 AND name='ADMIN'`, [CO]);
      expect(admin.role).toBe('ADMIN');
      expect(admin.roleId).toBe(adminRole.id);
      expect(admin.roleIsSystem).toBe(true);
      expect(admin.roleIsUnscoped).toBe(true);

      expect(pm.roleIsSystem).toBe(true);
      expect(pm.roleIsUnscoped).toBe(false); // PROJECT_MANAGER is project-scoped
      for (const u of items) {
        expect(u).not.toHaveProperty('password_hash');
        expect(u).not.toHaveProperty('passwordHash');
      }
    });

    it('findById carries the same fields, for a custom role too', async () => {
      const custom = await roleUseCases.createRole(adminActor, { name: 'READ_FIELDS_CUSTOM', isUnscoped: false });
      await ds.query(`UPDATE "user" SET role='READ_FIELDS_CUSTOM' WHERE id=$1`, [PM_USER]);
      try {
        const view = await usersQuery.findById(PM_USER, CO);
        expect(view.roleId).toBe(custom.id);
        expect(view.roleIsSystem).toBe(false);
        expect(view.roleIsUnscoped).toBe(false);
        expect(view).not.toHaveProperty('password_hash');
      } finally {
        await ds.query(`UPDATE "user" SET role='PROJECT_MANAGER' WHERE id=$1`, [PM_USER]);
      }
    });
  });

  // ── FR-AUD-034: Admin anti-lockout on the single-grant endpoints ──
  describe('ADMIN_LOCKOUT_FORBIDDEN — single-grant revoke/narrow', () => {
    it('rejects revoking (DELETE) an Admin grant', async () => {
      const [adminRole] = await ds.query(`SELECT id FROM "role" WHERE company_id=$1 AND name='ADMIN'`, [CO]);
      const [perm] = await ds.query(`SELECT id FROM "permission" WHERE role_id=$1 LIMIT 1`, [adminRole.id]);
      await expect(permissionUseCases.deletePermission(perm.id, adminActor))
        .rejects.toMatchObject({ message: 'ADMIN_LOCKOUT_FORBIDDEN' });
    });

    it('rejects narrowing (PATCH) an Admin grant — ALL→ASSIGNED and introducing a valueLimit', async () => {
      const [adminRole] = await ds.query(`SELECT id FROM "role" WHERE company_id=$1 AND name='ADMIN'`, [CO]);
      const [perm] = await ds.query(`SELECT id, version FROM "permission" WHERE role_id=$1 LIMIT 1`, [adminRole.id]);
      await expect(permissionUseCases.patchPermission(perm.id, adminActor, { projectScope: 'ASSIGNED', version: perm.version }))
        .rejects.toMatchObject({ message: 'ADMIN_LOCKOUT_FORBIDDEN' });
      await expect(permissionUseCases.patchPermission(perm.id, adminActor, { valueLimit: '1000.0000', version: perm.version }))
        .rejects.toMatchObject({ message: 'ADMIN_LOCKOUT_FORBIDDEN' });
    });

    it('leaves other roles unaffected — revoke + narrow on a built-in non-Admin role succeed', async () => {
      const [hr] = await ds.query(`SELECT id FROM "role" WHERE company_id=$1 AND name='HR_MANAGER'`, [CO]);
      const [perm] = await ds.query(`SELECT id, version FROM "permission" WHERE role_id=$1 AND project_scope='ALL' LIMIT 1`, [hr.id]);
      const patched = await permissionUseCases.patchPermission(perm.id, adminActor, { valueLimit: '5000.0000', version: perm.version });
      expect(patched.valueLimit).toBe('5000.0000');
      await expect(permissionUseCases.deletePermission(perm.id, adminActor)).resolves.toBeUndefined();
    });
  });

  // ── FR-AUD-013/019/020/035: the batch grid save ──
  describe('PATCH /api/roles/:id/permissions — atomic full-set replace', () => {
    it('replaces the grid: adds, revokes, updates scope/limit; unchanged grants keep their ids; version bumps; delta audited', async () => {
      const created = await roleUseCases.createRole(adminActor, {
        name: 'BATCH_ROLE',
        isUnscoped: false,
        permissions: [
          { resource: 'sales.ipcs', action: 'READ', projectScope: 'ASSIGNED' },              // kept unchanged
          { resource: 'sales.ipcs', action: 'CREATE', projectScope: 'ASSIGNED' },            // scope+limit updated
          { resource: 'cost_control.alerts', action: 'READ', projectScope: 'ASSIGNED' },     // revoked
        ],
      });
      const keptId = created.permissions.find(p => p.resource === 'sales.ipcs' && p.action === 'READ')!.id;
      audit.reset();

      const view = await roleUseCases.replaceRolePermissions(created.id, adminActor, {
        version: created.version,
        permissions: [
          { resource: 'sales.ipcs', action: 'READ', projectScope: 'ASSIGNED' },
          { resource: 'sales.ipcs', action: 'CREATE', projectScope: 'ALL', valueLimit: '500000.0000' },
          { resource: 'cost_control.budget_vs_actual', action: 'READ', projectScope: 'ASSIGNED' }, // added
        ],
      });

      expect(view.version).toBe(created.version + 1);
      expect(view.permissions.map(p => `${p.resource}:${p.action}`)).toEqual([
        'cost_control.budget_vs_actual:READ', 'sales.ipcs:CREATE', 'sales.ipcs:READ',
      ]);
      expect(view.permissions.find(p => p.action === 'READ' && p.resource === 'sales.ipcs')!.id).toBe(keptId); // id survives
      const updated = view.permissions.find(p => p.resource === 'sales.ipcs' && p.action === 'CREATE')!;
      expect(updated.projectScope).toBe('ALL');
      expect(updated.valueLimit).toBe('500000.0000');

      // Audited delta mirrors the diff — 1 CREATE + 1 DELETE + 1 UPDATE, nothing for the unchanged grant.
      expect(audit.ofType('Permission', 'CREATE')).toHaveLength(1);
      expect(audit.ofType('Permission', 'DELETE')).toHaveLength(1);
      expect(audit.ofType('Permission', 'UPDATE')).toHaveLength(1);

      // DB state matches + role version persisted.
      const rows = await grid(created.id);
      expect(rows).toHaveLength(3);
      const [dbRole] = await ds.query(`SELECT version FROM "role" WHERE id=$1`, [created.id]);
      expect(dbRole.version).toBe(created.version + 1);
    });

    it('supports a whole-module bulk grant in one call (every declared action of every resource)', async () => {
      const created = await roleUseCases.createRole(adminActor, { name: 'BULK_MAS_ROLE', isUnscoped: false });
      const mas = RESOURCE_CATALOG.find(m => m.module === 'MAS')!;
      const wholeModule = mas.resources.flatMap(r =>
        r.actions.map(a => ({ resource: r.resource, action: a, projectScope: 'ASSIGNED' as const })),
      );
      const view = await roleUseCases.replaceRolePermissions(created.id, adminActor, {
        version: created.version, permissions: wholeModule,
      });
      expect(view.permissions).toHaveLength(wholeModule.length);
      expect((await grid(created.id))).toHaveLength(wholeModule.length);
    });

    it('rejects a stale version with OPTIMISTIC_LOCK_CONFLICT — nothing applied', async () => {
      const created = await roleUseCases.createRole(adminActor, {
        name: 'STALE_ROLE', isUnscoped: false,
        permissions: [{ resource: 'sales.ipcs', action: 'READ', projectScope: 'ASSIGNED' }],
      });
      await expect(roleUseCases.replaceRolePermissions(created.id, adminActor, {
        version: created.version + 7, permissions: [],
      })).rejects.toMatchObject({ message: 'OPTIMISTIC_LOCK_CONFLICT' });
      expect(await grid(created.id)).toHaveLength(1); // untouched
    });

    it('rejects the whole batch on a catalogue-invalid pair or a duplicate pair (VALIDATION_ERROR)', async () => {
      const created = await roleUseCases.createRole(adminActor, { name: 'INVALID_BATCH_ROLE', isUnscoped: false });
      await expect(roleUseCases.replaceRolePermissions(created.id, adminActor, {
        version: created.version,
        permissions: [
          { resource: 'sales.ipcs', action: 'READ', projectScope: 'ASSIGNED' },
          { resource: 'ledger.journal_entries', action: 'POST', projectScope: 'ASSIGNED' }, // READ-only resource
        ],
      })).rejects.toBeInstanceOf(BadRequestException);
      await expect(roleUseCases.replaceRolePermissions(created.id, adminActor, {
        version: created.version,
        permissions: [
          { resource: 'sales.ipcs', action: 'READ', projectScope: 'ASSIGNED' },
          { resource: 'sales.ipcs', action: 'READ', projectScope: 'ALL' }, // duplicate (resource, action)
        ],
      })).rejects.toBeInstanceOf(BadRequestException);
      await expect(roleUseCases.replaceRolePermissions(created.id, adminActor, {
        version: created.version,
        permissions: [{ resource: 'sales.ipcs', action: 'READ', projectScope: 'ASSIGNED', valueLimit: '-1' }],
      })).rejects.toBeInstanceOf(BadRequestException); // negative limit
      expect(await grid(created.id)).toHaveLength(0); // nothing applied
    });

    it('rejects ASSIGNED scope on an unscoped role with ROLE_SCOPE_CONFLICT', async () => {
      const created = await roleUseCases.createRole(adminActor, { name: 'UNSCOPED_BATCH_ROLE', isUnscoped: true });
      await expect(roleUseCases.replaceRolePermissions(created.id, adminActor, {
        version: created.version,
        permissions: [{ resource: 'reports', action: 'READ', projectScope: 'ASSIGNED' }],
      })).rejects.toMatchObject({ message: 'ROLE_SCOPE_CONFLICT' });
    });

    it('rejects a replacement that drops or narrows an Admin grant (ADMIN_LOCKOUT_FORBIDDEN), whole batch', async () => {
      const [adminRole] = await ds.query(`SELECT id, version FROM "role" WHERE company_id=$1 AND name='ADMIN'`, [CO]);
      const current = await grid(adminRole.id);
      const allButOne = current.slice(1).map(p => ({
        resource: p.resource, action: p.action as any, projectScope: p.projectScope as any,
        valueLimit: p.valueLimit,
      }));
      await expect(roleUseCases.replaceRolePermissions(adminRole.id, adminActor, {
        version: adminRole.version, permissions: allButOne,
      })).rejects.toMatchObject({ message: 'ADMIN_LOCKOUT_FORBIDDEN' });
      expect((await grid(adminRole.id))).toHaveLength(current.length); // untouched
    });

    it('is atomic — a failure mid-write rolls the whole batch back (all-or-nothing)', async () => {
      const created = await roleUseCases.createRole(adminActor, {
        name: 'ATOMIC_ROLE', isUnscoped: false,
        permissions: [{ resource: 'cost_control.alerts', action: 'READ', projectScope: 'ASSIGNED' }],
      });
      const before = await grid(created.id);
      audit.failOn = e => e.entityType === 'Permission' && e.action === 'CREATE'; // blows up after the revoke applied
      await expect(roleUseCases.replaceRolePermissions(created.id, adminActor, {
        version: created.version,
        permissions: [{ resource: 'reports', action: 'READ', projectScope: 'ASSIGNED' }], // revoke alerts + add reports
      })).rejects.toThrow('audit failure (test-injected)');
      audit.failOn = null;
      expect(await grid(created.id)).toEqual(before); // revoke rolled back with the failed add
      const [dbRole] = await ds.query(`SELECT version FROM "role" WHERE id=$1`, [created.id]);
      expect(dbRole.version).toBe(created.version); // version bump rolled back too
    });
  });

  // ── Guard smoke (skill §13): the batch route requires (audit.roles, UPDATE) ──
  describe('guard wiring — (audit.roles, UPDATE)', () => {
    it('ADMIN passes; a role without the grant is 403', async () => {
      await expect(rolesGuard.canActivate(mockContext(adminActor, 'audit.roles', 'UPDATE'))).resolves.toBe(true);
      jest.restoreAllMocks();
      const pmActor: Actor = { ...adminActor, role: 'PROJECT_MANAGER', isUnscoped: false };
      await expect(rolesGuard.canActivate(mockContext(pmActor, 'audit.roles', 'UPDATE'))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
