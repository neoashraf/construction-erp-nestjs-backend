/**
 * aud-catalog-lifecycle (#44) — Resource-Catalogue lifecycle: audited orphan-grant sweep +
 * catalogue-valid-only Admin anti-lockout + seed-if-absent re-grant, real Postgres (Testcontainers).
 *
 * Covers the brief's acceptance criteria:
 *   - FR-AUD-035/020 sweep: seed-time sweepOrphanPermissions deletes every permission row whose
 *     (resource, action) the catalogue no longer declares — across ALL roles — writing one audited
 *     DELETE (chained seal, before-state, sweptReason) per row; a clean catalogue is a no-op.
 *   - FR-AUD-034/035 lockout scope: with an orphan on the built-in Admin role, the batch replace
 *     omitting it SUCCEEDS (revoking it), while omitting a catalogue-valid grant still rejects
 *     ADMIN_LOCKOUT_FORBIDDEN; single-grant DELETE of the orphan succeeds too.
 *   - FR-AUD-034/035 re-seed: seedRolesPermissions (insert-if-absent, Admin set derived from the
 *     whole catalogue) restores a missing Admin grant on the next deploy — how a newly added
 *     catalogue resource reaches Admin — without clobbering Admin-edited grants on other roles.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
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
import { computeSeal } from '../src/core/audit/infrastructure/typeorm-audit-log.repository';
import { RoleUseCases, PermissionUseCases } from '../src/core/auth/application/rbac.use-cases';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { seedRolesPermissions, sweepOrphanPermissions } from '../src/database/seeds/seed-roles-permissions';
import { Actor } from '../src/core/tenancy/tenant-context';
import { AuditEntry, AuditService } from '../src/core/audit/application/audit.port';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000f4401';
const FY = '00000000-0000-0000-0000-0000000f44f1';
const ADMIN_USER = '00000000-0000-0000-0000-0000000f44a1';

const ORPHAN_RESOURCE = 'legacy.removed_screen'; // deliberately NOT in resource-catalog.ts

const adminActor: Actor = {
  userId: ADMIN_USER, companyId: CO, financialYearId: FY,
  role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};

class CapturingAuditService implements AuditService {
  events: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> { this.events.push(entry); }
  reset() { this.events = []; }
}

describe('aud-catalog-lifecycle (#44) — orphan sweep + lockout scope + re-seed (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let roleUseCases: RoleUseCases;
  let permissionUseCases: PermissionUseCases;
  let audit: CapturingAuditService;
  let adminRoleId: string;

  async function insertOrphan(roleId: string, action = 'READ'): Promise<string> {
    const rows = await ds.query(
      `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'ALL', 1) RETURNING id`,
      [roleId, CO, ORPHAN_RESOURCE, action],
    );
    return rows[0].id;
  }

  async function adminGrid(): Promise<Array<{ resource: string; action: string; project_scope: string }>> {
    return ds.query(`SELECT resource, action, project_scope FROM "permission" WHERE role_id = $1`, [adminRoleId]);
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
    await ds.query(
      `INSERT INTO "user" (id, company_id, financial_year_id, email, password_hash, name, role, is_active, must_change_password, version)
       VALUES ($1, $2, $3, 'admin@ze.local', 'x', 'Admin', 'ADMIN', true, false, 1)`,
      [ADMIN_USER, CO, FY],
    );

    const [row] = await ds.query(`SELECT id FROM "role" WHERE company_id = $1 AND name = 'ADMIN'`, [CO]);
    adminRoleId = row.id;

    const roleRepo = new TypeOrmRoleRepository(ds);
    const permRepo = new TypeOrmPermissionRepository(ds);
    const uow = new TypeOrmUnitOfWork(ds);
    audit = new CapturingAuditService();
    roleUseCases = new RoleUseCases(roleRepo, permRepo, audit, uow);
    permissionUseCases = new PermissionUseCases(roleRepo, permRepo, audit, uow);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    audit.reset();
    // Restore the seeded baseline: no orphans, full Admin grid (seed-if-absent fills any gap).
    await ds.query(`DELETE FROM "permission" WHERE company_id = $1 AND resource = $2`, [CO, ORPHAN_RESOURCE]);
    await seedRolesPermissions(ds, CO);
  });

  // ── the sweep (FR-AUD-035/020) ──────────────────────────────────────────────
  describe('sweepOrphanPermissions', () => {
    it('deletes every orphan row across ALL roles, audits each as a chained DELETE with before-state; clean run is a no-op', async () => {
      const [customRole] = await ds.query(
        `INSERT INTO "role" (id, company_id, name, is_system, is_unscoped, version) VALUES (gen_random_uuid(), $1, 'Temp Custom', false, true, 1) RETURNING id`,
        [CO],
      );
      const adminOrphanId = await insertOrphan(adminRoleId, 'READ');
      const customOrphanId = await insertOrphan(customRole.id, 'UPDATE');

      const swept = await sweepOrphanPermissions(ds, CO);
      expect(swept).toBe(2);

      const remaining = await ds.query(`SELECT id FROM "permission" WHERE company_id = $1 AND resource = $2`, [CO, ORPHAN_RESOURCE]);
      expect(remaining).toEqual([]);

      // Each deletion audited: DELETE / Permission / before carries the grant + sweptReason; actor = the ADMIN user.
      const logs = await ds.query(
        `SELECT entity_id, user_id, action, entity_type, before, after, seal FROM "audit_log"
         WHERE company_id = $1 AND entity_type = 'Permission' AND action = 'DELETE' ORDER BY created_at`,
        [CO],
      );
      expect(logs).toHaveLength(2);
      const byEntity = new Map(logs.map((l: any) => [l.entity_id, l]));
      for (const [orphanId, roleId, action] of [
        [adminOrphanId, adminRoleId, 'READ'],
        [customOrphanId, customRole.id, 'UPDATE'],
      ] as const) {
        const log: any = byEntity.get(orphanId);
        expect(log).toBeDefined();
        expect(log.user_id).toBe(ADMIN_USER);
        expect(log.after).toBeNull();
        expect(log.before).toMatchObject({
          roleId, resource: ORPHAN_RESOURCE, action, projectScope: 'ALL', sweptReason: 'RESOURCE_NOT_IN_CATALOGUE',
        });
        expect(typeof log.seal).toBe('string');
        expect(log.seal.length).toBeGreaterThan(0);
      }
      // The two seals chain (second differs from first; both non-empty) — same scheme as RealAuditService.
      expect(logs[0].seal).not.toBe(logs[1].seal);

      // Idempotent: a second run finds nothing.
      await expect(sweepOrphanPermissions(ds, CO)).resolves.toBe(0);
      const logsAfter = await ds.query(
        `SELECT count(*)::int AS n FROM "audit_log" WHERE company_id = $1 AND entity_type = 'Permission' AND action = 'DELETE'`,
        [CO],
      );
      expect(logsAfter[0].n).toBe(2);

      await ds.query(`DELETE FROM "role" WHERE id = $1`, [customRole.id]);
    });

    it('uses the documented seal scheme (recomputable from the row itself + the previous seal)', async () => {
      const orphanId = await insertOrphan(adminRoleId);
      const [prev] = await ds.query(`SELECT seal FROM "audit_log" WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`, [CO]);
      await sweepOrphanPermissions(ds, CO);
      const [log] = await ds.query(
        `SELECT user_id, before, seal, to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso
         FROM "audit_log" WHERE company_id = $1 AND entity_id = $2`,
        [CO, orphanId],
      );
      const expected = computeSeal(CO, 'DELETE', 'Permission', orphanId, log.user_id, log.before, null, log.created_at_iso, prev?.seal ?? null);
      expect(log.seal).toBe(expected);
    });
  });

  // ── lockout scope on the real stack (FR-AUD-034/035) ────────────────────────
  describe('Admin anti-lockout scoped to catalogue-valid grants', () => {
    it('batch replace omitting the orphan SUCCEEDS and revokes it; omitting a catalogue-valid grant still 409s', async () => {
      await insertOrphan(adminRoleId);
      const current = await adminGrid();
      const valid = current.filter(g => g.resource !== ORPHAN_RESOURCE);
      const [{ version }] = await ds.query(`SELECT version FROM "role" WHERE id = $1`, [adminRoleId]);

      // Omitting a VALID grant → whole batch rejected, orphan untouched.
      await expect(
        roleUseCases.replaceRolePermissions(adminRoleId, adminActor, {
          version,
          permissions: valid.slice(1).map(g => ({ resource: g.resource, action: g.action as any, projectScope: g.project_scope as any })),
        }),
      ).rejects.toMatchObject({ message: 'ADMIN_LOCKOUT_FORBIDDEN' });
      expect((await adminGrid()).some(g => g.resource === ORPHAN_RESOURCE)).toBe(true);

      // Full valid set (orphan omitted) → succeeds; orphan revoked; version bumped.
      const result = await roleUseCases.replaceRolePermissions(adminRoleId, adminActor, {
        version,
        permissions: valid.map(g => ({ resource: g.resource, action: g.action as any, projectScope: g.project_scope as any })),
      });
      expect(result.version).toBe(version + 1);
      expect((await adminGrid()).some(g => g.resource === ORPHAN_RESOURCE)).toBe(false);
      const deletes = audit.events.filter(e => e.action === 'DELETE' && e.entityType === 'Permission');
      expect(deletes).toHaveLength(1);
      expect(deletes[0].before).toMatchObject({ resource: ORPHAN_RESOURCE });
    });

    it('single-grant DELETE of an orphan Admin grant succeeds; a catalogue-valid Admin grant remains protected', async () => {
      const orphanId = await insertOrphan(adminRoleId);
      await expect(permissionUseCases.deletePermission(orphanId, adminActor)).resolves.toBeUndefined();

      const [validGrant] = await ds.query(
        `SELECT id FROM "permission" WHERE role_id = $1 AND resource = 'dashboard' AND action = 'READ'`,
        [adminRoleId],
      );
      await expect(permissionUseCases.deletePermission(validGrant.id, adminActor)).rejects.toMatchObject({
        message: 'ADMIN_LOCKOUT_FORBIDDEN',
      });
    });
  });

  // ── re-seed after a catalogue addition (FR-AUD-034/035) ─────────────────────
  describe('seed-if-absent re-grant', () => {
    it('a missing Admin grant (≙ a newly added catalogue resource) is re-granted by the next seed run; other roles untouched', async () => {
      // Simulate "resource just added to the catalogue": Admin doesn't hold it yet.
      await ds.query(`DELETE FROM "permission" WHERE role_id = $1 AND resource = 'dashboard' AND action = 'READ'`, [adminRoleId]);
      // An Admin-edited grant on another role must survive the re-seed (seed-if-absent, never clobbers).
      const [pmRole] = await ds.query(`SELECT id FROM "role" WHERE company_id = $1 AND name = 'PROJECT_MANAGER'`, [CO]);
      await ds.query(
        `UPDATE "permission" SET value_limit = 12345.6789 WHERE role_id = $1 AND resource = 'dashboard' AND action = 'READ'`,
        [pmRole.id],
      );

      await sweepOrphanPermissions(ds, CO); // deploy order: sweep first (no-op here) …
      await seedRolesPermissions(ds, CO); //   … then the idempotent seed.

      const restored = await ds.query(
        `SELECT project_scope FROM "permission" WHERE role_id = $1 AND resource = 'dashboard' AND action = 'READ'`,
        [adminRoleId],
      );
      expect(restored).toHaveLength(1);
      expect(restored[0].project_scope).toBe('ALL');

      const [pmGrant] = await ds.query(
        `SELECT value_limit::text AS v FROM "permission" WHERE role_id = $1 AND resource = 'dashboard' AND action = 'READ'`,
        [pmRole.id],
      );
      expect(pmGrant.v).toBe('12345.6789');
      await ds.query(`UPDATE "permission" SET value_limit = NULL WHERE role_id = $1 AND resource = 'dashboard' AND action = 'READ'`, [pmRole.id]);
    });
  });
});
