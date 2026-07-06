/**
 * Anti-lockout scope = CATALOGUE-VALID grants only (aud-catalog-lifecycle #44 — FR-AUD-034/035).
 *
 * Use-case tests with fakes (skill §13): the built-in Admin role's core access is its
 * catalogue-valid grant set. Orphan grants — (resource, action) pairs the Resource Catalogue no
 * longer declares — are exempt from ADMIN_LOCKOUT_FORBIDDEN on every path (batch replace,
 * single DELETE, single PATCH), otherwise one catalogue removal makes the Admin grid permanently
 * unsaveable: the batch can neither include the orphan (catalogue validation, 400) nor omit it
 * (lockout, 409). Catalogue-valid Admin grants keep the exact #43 upward-only behaviour.
 */
import { ConflictException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { RoleUseCases, PermissionUseCases } from '../../../src/core/auth/application/rbac.use-cases';
import { Role } from '../../../src/core/auth/domain/role.entity';
import { Permission, ActionCode, ProjectScope } from '../../../src/core/auth/domain/permission.entity';
import { RoleRepository } from '../../../src/core/auth/domain/ports/role.repository.port';
import { PermissionRepository } from '../../../src/core/auth/domain/ports/permission.repository.port';
import { AuditEntry, AuditService } from '../../../src/core/audit/application/audit.port';
import { UnitOfWork } from '../../../src/common/ports/unit-of-work.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const CO = 'co-1';
const ADMIN_ROLE_ID = 'role-admin';
const CUSTOM_ROLE_ID = 'role-custom';

/** An orphan pair — deliberately NOT in resource-catalog.ts (a removed screen's leftover grant). */
const ORPHAN = { resource: 'legacy.removed_screen', action: 'READ' as ActionCode };
/** Catalogue-valid pairs used as Admin's live core access in these tests. */
const VALID_A = { resource: 'dashboard', action: 'READ' as ActionCode };
const VALID_B = { resource: 'audit.roles', action: 'UPDATE' as ActionCode };

const actor: Actor = {
  userId: 'u-admin', companyId: CO, financialYearId: 'fy-1',
  role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};

class FakeUow implements UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T> { return work(); }
}

class FakeRoles implements RoleRepository {
  byId = new Map<string, Role>();
  async findById(id: string, companyId: string) { const r = this.byId.get(id); return r && r.props.companyId === companyId ? r : null; }
  async findByName(companyId: string, name: string) {
    return [...this.byId.values()].find(r => r.props.companyId === companyId && r.props.name === name) ?? null;
  }
  async findAll(companyId: string) { return [...this.byId.values()].filter(r => r.props.companyId === companyId); }
  async save(role: Role) { this.byId.set(role.id, role); }
  async delete(id: string) { this.byId.delete(id); }
  async countUsers() { return 0; }
  async renameUserReferences() { /* noop */ }
}

class FakePerms implements PermissionRepository {
  byId = new Map<string, Permission>();
  async findById(id: string, companyId: string) { const p = this.byId.get(id); return p && p.props.companyId === companyId ? p : null; }
  async findByRoleId(roleId: string, companyId: string) {
    return [...this.byId.values()].filter(p => p.props.roleId === roleId && p.props.companyId === companyId);
  }
  async findByRoleIdResourceAction(roleId: string, resource: string, action: ActionCode, companyId: string) {
    return (
      [...this.byId.values()].find(
        p => p.props.roleId === roleId && p.props.resource === resource && p.props.action === action && p.props.companyId === companyId,
      ) ?? null
    );
  }
  async findAll(companyId: string) { return [...this.byId.values()].filter(p => p.props.companyId === companyId); }
  async save(permission: Permission) { this.byId.set(permission.id, permission); }
  async delete(id: string) { this.byId.delete(id); }
  async deleteByRoleId(roleId: string) {
    for (const [id, p] of this.byId) if (p.props.roleId === roleId) this.byId.delete(id);
  }
}

class FakeAudit implements AuditService {
  events: AuditEntry[] = [];
  async record(entry: AuditEntry) { this.events.push(entry); }
}

function grant(id: string, roleId: string, pair: { resource: string; action: ActionCode }, scope: ProjectScope = 'ALL'): Permission {
  return Permission.rehydrate(id, {
    roleId, companyId: CO, resource: pair.resource, action: pair.action, projectScope: scope, valueLimit: null, version: 1,
  });
}

describe('rbac-catalog-lifecycle (#44) — Admin anti-lockout scoped to catalogue-valid grants', () => {
  let roles: FakeRoles;
  let perms: FakePerms;
  let audit: FakeAudit;
  let roleUseCases: RoleUseCases;
  let permissionUseCases: PermissionUseCases;

  beforeEach(() => {
    roles = new FakeRoles();
    perms = new FakePerms();
    audit = new FakeAudit();
    const uow = new FakeUow();
    roleUseCases = new RoleUseCases(roles as any, perms as any, audit, uow);
    permissionUseCases = new PermissionUseCases(roles as any, perms as any, audit, uow);

    roles.byId.set(ADMIN_ROLE_ID, Role.rehydrate(ADMIN_ROLE_ID, {
      companyId: CO, name: 'ADMIN', isSystem: true, approvalLimit: null, isUnscoped: true, version: 1,
    }));
    roles.byId.set(CUSTOM_ROLE_ID, Role.rehydrate(CUSTOM_ROLE_ID, {
      companyId: CO, name: 'Site Auditor', isSystem: false, approvalLimit: null, isUnscoped: true, version: 1,
    }));

    // Admin: two catalogue-valid grants + one orphan. Custom role: one orphan.
    perms.byId.set('p-valid-a', grant('p-valid-a', ADMIN_ROLE_ID, VALID_A));
    perms.byId.set('p-valid-b', grant('p-valid-b', ADMIN_ROLE_ID, VALID_B));
    perms.byId.set('p-orphan', grant('p-orphan', ADMIN_ROLE_ID, ORPHAN));
    perms.byId.set('p-custom-orphan', grant('p-custom-orphan', CUSTOM_ROLE_ID, ORPHAN));
  });

  describe('batch replace (PATCH /api/roles/:id/permissions)', () => {
    it('an Admin full-set replace OMITTING the orphan succeeds — the orphan is revoked and audited', async () => {
      const result = await roleUseCases.replaceRolePermissions(ADMIN_ROLE_ID, actor, {
        version: 1,
        permissions: [
          { resource: VALID_A.resource, action: VALID_A.action, projectScope: 'ALL' },
          { resource: VALID_B.resource, action: VALID_B.action, projectScope: 'ALL' },
        ],
      });

      expect(result.permissions.map(p => p.resource).sort()).toEqual([VALID_B.resource, VALID_A.resource].sort());
      expect(perms.byId.has('p-orphan')).toBe(false);
      const deletes = audit.events.filter(e => e.action === 'DELETE' && e.entityType === 'Permission');
      expect(deletes).toHaveLength(1);
      expect(deletes[0].before).toMatchObject({ resource: ORPHAN.resource, action: ORPHAN.action });
      expect(result.version).toBe(2);
    });

    it('an Admin replace omitting a CATALOGUE-VALID grant still rejects ADMIN_LOCKOUT_FORBIDDEN (whole batch, nothing applied)', async () => {
      const attempt = roleUseCases.replaceRolePermissions(ADMIN_ROLE_ID, actor, {
        version: 1,
        permissions: [{ resource: VALID_A.resource, action: VALID_A.action, projectScope: 'ALL' }], // VALID_B omitted
      });
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({ message: 'ADMIN_LOCKOUT_FORBIDDEN' });
      // Nothing applied — the orphan and both valid grants are untouched.
      expect(perms.byId.has('p-orphan')).toBe(true);
      expect(perms.byId.has('p-valid-b')).toBe(true);
      expect(roles.byId.get(ADMIN_ROLE_ID)!.props.version).toBe(1);
    });

    it('narrowing a catalogue-valid Admin grant in the replacement still rejects (upward-only unchanged from #43)', async () => {
      await expect(
        roleUseCases.replaceRolePermissions(ADMIN_ROLE_ID, actor, {
          version: 1,
          permissions: [
            { resource: VALID_A.resource, action: VALID_A.action, projectScope: 'ALL', valueLimit: '100.0000' }, // limit introduced = narrow
            { resource: VALID_B.resource, action: VALID_B.action, projectScope: 'ALL' },
          ],
        }),
      ).rejects.toMatchObject({ message: 'ADMIN_LOCKOUT_FORBIDDEN' });
    });

    it('the replacement still cannot INCLUDE the orphan (catalogue validation, VALIDATION_ERROR) — revocation is the only exit', async () => {
      await expect(
        roleUseCases.replaceRolePermissions(ADMIN_ROLE_ID, actor, {
          version: 1,
          permissions: [
            { resource: ORPHAN.resource, action: ORPHAN.action, projectScope: 'ALL' },
            { resource: VALID_A.resource, action: VALID_A.action, projectScope: 'ALL' },
            { resource: VALID_B.resource, action: VALID_B.action, projectScope: 'ALL' },
          ],
        }),
      ).rejects.toMatchObject({ message: 'VALIDATION_ERROR' });
    });
  });

  describe('single-grant paths (DELETE / PATCH /api/permissions/:id)', () => {
    it('DELETE of an orphan Admin grant succeeds and is audited', async () => {
      await permissionUseCases.deletePermission('p-orphan', actor);
      expect(perms.byId.has('p-orphan')).toBe(false);
      const del = audit.events.find(e => e.action === 'DELETE' && e.entityId === 'p-orphan');
      expect(del?.before).toMatchObject({ resource: ORPHAN.resource });
    });

    it('DELETE of a catalogue-valid Admin grant remains ADMIN_LOCKOUT_FORBIDDEN', async () => {
      await expect(permissionUseCases.deletePermission('p-valid-a', actor)).rejects.toMatchObject({
        message: 'ADMIN_LOCKOUT_FORBIDDEN',
      });
      expect(perms.byId.has('p-valid-a')).toBe(true);
    });

    it('PATCH narrowing an orphan Admin grant succeeds (limit introduced on a dead grant is not a lockout)', async () => {
      const result = await permissionUseCases.patchPermission('p-orphan', actor, { valueLimit: '50.0000', version: 1 });
      expect(result.valueLimit).toBe(new Decimal('50.0000').toFixed(4));
    });

    it('PATCH narrowing a catalogue-valid Admin grant remains ADMIN_LOCKOUT_FORBIDDEN', async () => {
      await expect(
        permissionUseCases.patchPermission('p-valid-a', actor, { valueLimit: '50.0000', version: 1 }),
      ).rejects.toMatchObject({ message: 'ADMIN_LOCKOUT_FORBIDDEN' });
    });

    it('non-Admin roles are unaffected either way: orphan and valid grants both stay freely revocable', async () => {
      await permissionUseCases.deletePermission('p-custom-orphan', actor);
      expect(perms.byId.has('p-custom-orphan')).toBe(false);
    });
  });
});
