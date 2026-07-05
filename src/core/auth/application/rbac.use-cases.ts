/**
 * RBAC use cases (AUD application — FR-AUD-011..020, FR-AUD-034/035). Role/Permission/UserProjectAssignment
 * mutations. Each mutating use case calls AuditService.record inside uow.run.
 *
 * RBAC v2: permissions are resource-level (validated against the Resource Catalogue); roles are CRUD-able
 * with protected built-ins (is_system) — DUPLICATE_ROLE_NAME / SYSTEM_ROLE_IMMUTABLE / ROLE_IN_USE.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import Decimal from 'decimal.js';
import { UnitOfWork, UNIT_OF_WORK } from '../../../common/ports/unit-of-work.port';
import { EventPublisher, EVENT_PUBLISHER } from '../../../common/ports/driven-ports';
import { AuthEvents, AuthEvent } from '../domain/auth-events';
import { RoleRepository, ROLE_REPOSITORY } from '../domain/ports/role.repository.port';
import { PermissionRepository, PERMISSION_REPOSITORY } from '../domain/ports/permission.repository.port';
import { UserProjectAssignmentRepository, USER_PROJECT_ASSIGNMENT_REPOSITORY } from '../domain/ports/user-project-assignment.repository.port';
import { UserRepository, USER_REPOSITORY } from '../domain/ports/user.repository.port';
import { Permission, ActionCode, ProjectScope } from '../domain/permission.entity';
import { Role, SystemRoleImmutableError } from '../domain/role.entity';
import { isValidResource, resourceAllowsAction } from '../domain/resource-catalog';
import { AUDIT_SERVICE, AuditService } from '../../audit/application/audit.port';
import { Actor } from '../../tenancy/tenant-context';
import { PasswordHasher, PASSWORD_HASHER } from '../domain/ports/password-hasher.port';
import { RefreshTokenStore, REFRESH_TOKEN_STORE } from '../domain/ports/refresh-token-store.port';

type PermissionInput = { resource: string; action: ActionCode; projectScope: ProjectScope; valueLimit?: string | null };

function assertResourceAction(resource: string, action: ActionCode): void {
  if (!isValidResource(resource) || !resourceAllowsAction(resource, action)) {
    throw new BadRequestException('VALIDATION_ERROR');
  }
}

// ── Role use cases ──────────────────────────────────────────────────────────

@Injectable()
export class RoleUseCases {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(PERMISSION_REPOSITORY) private readonly permissions: PermissionRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  /** POST /api/roles — create a custom role (is_system=false), optionally seeding its grid. FR-AUD-034. */
  async createRole(
    actor: Actor,
    dto: { name: string; isUnscoped?: boolean; approvalLimit?: string | null; permissions?: PermissionInput[] },
  ) {
    return this.uow.run(async () => {
      const dup = await this.roles.findByName(actor.companyId, dto.name);
      if (dup) throw new ConflictException('DUPLICATE_ROLE_NAME');
      (dto.permissions ?? []).forEach(p => assertResourceAction(p.resource, p.action));

      const role = Role.create(crypto.randomUUID(), {
        companyId: actor.companyId,
        name: dto.name,
        approvalLimit: dto.approvalLimit != null ? new Decimal(dto.approvalLimit) : null,
        isUnscoped: dto.isUnscoped ?? false,
      });
      await this.roles.save(role);

      const created: Permission[] = [];
      for (const p of dto.permissions ?? []) {
        const perm = Permission.create(crypto.randomUUID(), {
          roleId: role.id,
          companyId: actor.companyId,
          resource: p.resource,
          action: p.action,
          projectScope: p.projectScope,
          valueLimit: p.valueLimit != null ? new Decimal(p.valueLimit) : null,
        });
        await this.permissions.save(perm);
        created.push(perm);
      }

      await this.audit.record({
        action: 'CREATE',
        entityType: 'Role',
        entityId: role.id,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: null,
        after: { name: role.props.name, isUnscoped: role.props.isUnscoped },
      });
      return roleView(role, 0, created);
    });
  }

  /** PATCH /api/roles/:id — rename (custom only) + limit/scope. FR-AUD-016/019/034. */
  async patchRole(
    id: string,
    actor: Actor,
    dto: { name?: string; approvalLimit?: string | null; isUnscoped?: boolean; version: number },
  ) {
    return this.uow.run(async () => {
      const role = await this.roles.findById(id, actor.companyId);
      if (!role) throw new NotFoundException('Role not found');
      if (role.props.version !== dto.version) throw new ConflictException('OPTIMISTIC_LOCK_CONFLICT');

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      if (dto.name !== undefined && dto.name !== role.props.name) {
        const dup = await this.roles.findByName(actor.companyId, dto.name);
        if (dup) throw new ConflictException('DUPLICATE_ROLE_NAME');
        const oldName = role.props.name;
        try {
          const r = role.rename(dto.name);
          Object.assign(before, r.before); Object.assign(after, r.after);
        } catch (e) {
          if (e instanceof SystemRoleImmutableError) throw new ConflictException('SYSTEM_ROLE_IMMUTABLE');
          throw e;
        }
        await this.roles.renameUserReferences(actor.companyId, oldName, dto.name);
      }

      const patch = role.patch({
        approvalLimit: dto.approvalLimit !== undefined ? (dto.approvalLimit !== null ? new Decimal(dto.approvalLimit) : null) : undefined,
        isUnscoped: dto.isUnscoped,
      });
      Object.assign(before, patch.before); Object.assign(after, patch.after);

      await this.roles.save(role);
      await this.audit.record({
        action: 'UPDATE', entityType: 'Role', entityId: id,
        actorId: actor.userId, companyId: actor.companyId, before, after,
      });
      const userCount = await this.roles.countUsers(actor.companyId, role.props.name);
      return roleView(role, userCount);
    });
  }

  /** DELETE /api/roles/:id — custom only; blocked while assigned. FR-AUD-034. */
  async deleteRole(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const role = await this.roles.findById(id, actor.companyId);
      if (!role) throw new NotFoundException('Role not found');
      try {
        role.assertDeletable();
      } catch (e) {
        if (e instanceof SystemRoleImmutableError) throw new ConflictException('SYSTEM_ROLE_IMMUTABLE');
        throw e;
      }
      const userCount = await this.roles.countUsers(actor.companyId, role.props.name);
      if (userCount > 0) throw new ConflictException('ROLE_IN_USE');

      await this.permissions.deleteByRoleId(id, actor.companyId);
      await this.roles.delete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE' as any, entityType: 'Role', entityId: id,
        actorId: actor.userId, companyId: actor.companyId,
        before: { name: role.props.name }, after: null,
      });
    });
  }
}

function roleView(role: Role, userCount: number, permissions: Permission[] = []) {
  const p = role.props;
  return {
    id: role.id,
    name: p.name,
    isSystem: p.isSystem,
    approvalLimit: p.approvalLimit?.toFixed(4) ?? null,
    isUnscoped: p.isUnscoped,
    userCount,
    version: p.version,
    permissions: permissions.map(pm => ({
      id: pm.id, resource: pm.props.resource, action: pm.props.action,
      projectScope: pm.props.projectScope, valueLimit: pm.props.valueLimit?.toFixed(4) ?? null,
    })),
  };
}

// ── Permission use cases ─────────────────────────────────────────────────────

@Injectable()
export class PermissionUseCases {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(PERMISSION_REPOSITORY) private readonly permissions: PermissionRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async createPermission(
    actor: Actor,
    dto: { roleId: string; resource: string; action: ActionCode; projectScope: ProjectScope; valueLimit?: string | null },
  ) {
    return this.uow.run(async () => {
      const role = await this.roles.findById(dto.roleId, actor.companyId);
      if (!role) throw new NotFoundException('Role not found');
      assertResourceAction(dto.resource, dto.action);

      const existing = await this.permissions.findByRoleIdResourceAction(dto.roleId, dto.resource, dto.action, actor.companyId);
      if (existing) throw new ConflictException('DUPLICATE_PERMISSION');

      const perm = Permission.create(crypto.randomUUID(), {
        roleId: dto.roleId,
        companyId: actor.companyId,
        resource: dto.resource,
        action: dto.action,
        projectScope: dto.projectScope,
        valueLimit: dto.valueLimit != null ? new Decimal(dto.valueLimit) : null,
      });
      await this.permissions.save(perm);
      await this.audit.record({
        action: 'CREATE', entityType: 'Permission', entityId: perm.id,
        actorId: actor.userId, companyId: actor.companyId,
        before: null, after: { resource: dto.resource, action: dto.action, projectScope: dto.projectScope },
      });
      const p = perm.props;
      return { id: perm.id, roleId: p.roleId, resource: p.resource, action: p.action, projectScope: p.projectScope, valueLimit: p.valueLimit?.toFixed(4) ?? null };
    });
  }

  async patchPermission(
    id: string,
    actor: Actor,
    dto: { projectScope?: ProjectScope; valueLimit?: string | null; version: number },
  ) {
    return this.uow.run(async () => {
      const perm = await this.permissions.findById(id, actor.companyId);
      if (!perm) throw new NotFoundException('Permission not found');
      if (perm.props.version !== dto.version) throw new ConflictException('OPTIMISTIC_LOCK_CONFLICT');

      const updates: { projectScope?: ProjectScope; valueLimit?: Decimal | null } = {};
      if (dto.projectScope !== undefined) updates.projectScope = dto.projectScope;
      if (dto.valueLimit !== undefined) {
        updates.valueLimit = dto.valueLimit !== null ? new Decimal(dto.valueLimit) : null;
      }
      const { before, after } = perm.patch(updates);
      await this.permissions.save(perm);
      await this.audit.record({
        action: 'UPDATE', entityType: 'Permission', entityId: id,
        actorId: actor.userId, companyId: actor.companyId,
        before: before as Record<string, unknown>, after: after as Record<string, unknown>,
      });
      const p = perm.props;
      return { id: perm.id, resource: p.resource, action: p.action, projectScope: p.projectScope, valueLimit: p.valueLimit?.toFixed(4) ?? null };
    });
  }

  async deletePermission(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const perm = await this.permissions.findById(id, actor.companyId);
      if (!perm) throw new NotFoundException('Permission not found');
      const before = { resource: perm.props.resource, action: perm.props.action, projectScope: perm.props.projectScope };
      await this.permissions.delete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE' as any, entityType: 'Permission', entityId: id,
        actorId: actor.userId, companyId: actor.companyId,
        before, after: null,
      });
    });
  }
}

// ── UserProject use cases ────────────────────────────────────────────────────

@Injectable()
export class UserProjectUseCases {
  constructor(
    @Inject(USER_PROJECT_ASSIGNMENT_REPOSITORY) private readonly assignments: UserProjectAssignmentRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async replaceProjects(userId: string, actor: Actor, projectIds: string[]): Promise<{ added: string[]; removed: string[] }> {
    return this.uow.run(async () => {
      const user = await this.users.findById(userId);
      if (!user || user.props.companyId !== actor.companyId) throw new NotFoundException('User not found');

      // Cannot assign projects to an unscoped role
      const role = await this.roles.findByName(actor.companyId, user.props.role);
      if (role?.props.isUnscoped) throw new ConflictException('ROLE_SCOPE_CONFLICT');

      const { added, removed } = await this.assignments.replaceSet(userId, actor.companyId, projectIds);
      for (const projectId of added) {
        await this.audit.record({
          action: 'CREATE', entityType: 'UserProjectAssignment', entityId: `${userId}:${projectId}`,
          actorId: actor.userId, companyId: actor.companyId, before: null, after: { userId, projectId },
        });
      }
      for (const projectId of removed) {
        await this.audit.record({
          action: 'DELETE' as any, entityType: 'UserProjectAssignment', entityId: `${userId}:${projectId}`,
          actorId: actor.userId, companyId: actor.companyId, before: { userId, projectId }, after: null,
        });
      }
      return { added, removed };
    });
  }

  async unassignProject(userId: string, projectId: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const assignment = await this.assignments.findByUserAndProject(userId, projectId);
      if (!assignment) throw new NotFoundException('Assignment not found');
      await this.assignments.unassign(userId, projectId);
      await this.audit.record({
        action: 'DELETE' as any, entityType: 'UserProjectAssignment', entityId: `${userId}:${projectId}`,
        actorId: actor.userId, companyId: actor.companyId, before: { userId, projectId }, after: null,
      });
    });
  }
}

// ── User admin use cases ─────────────────────────────────────────────────────

@Injectable()
export class UserAdminUseCases {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(REFRESH_TOKEN_STORE) private readonly store: RefreshTokenStore,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    // Out-of-band notification producer — @Optional so existing constructors/tests are unaffected.
    @Optional() @Inject(EVENT_PUBLISHER) private readonly events?: EventPublisher,
  ) {}

  /** Publish a domain event AFTER commit; best-effort — never fails the business op (FR-NTF-012). */
  private async publish(event: AuthEvent): Promise<void> {
    try { await this.events?.publish([event]); } catch { /* best-effort */ }
  }

  async createUser(actor: Actor, dto: {
    email: string; name: string; roleId: string; financialYearId: string;
    phone?: string; temporaryPassword: string; isActive?: boolean;
  }) {
    const result = await this.uow.run(async () => {
      const { User } = await import('../domain/user');
      const role = await this.roles.findById(dto.roleId, actor.companyId);
      if (!role) throw new NotFoundException('Role not found');

      const hash = await this.hasher.hash(dto.temporaryPassword);
      const user = User.create(crypto.randomUUID(), {
        companyId: actor.companyId,
        financialYearId: dto.financialYearId,
        email: dto.email,
        passwordHash: hash,
        name: dto.name,
        role: role.props.name,
        phone: dto.phone ?? null,
        isActive: dto.isActive ?? true,
      });
      await this.users.save(user);
      await this.audit.record({
        action: 'CREATE', entityType: 'User', entityId: user.id,
        actorId: actor.userId, companyId: actor.companyId,
        before: null, after: { email: user.props.email, name: user.props.name, role: user.props.role },
      });
      return { id: user.id, email: user.props.email, name: user.props.name, role: user.props.role, isActive: user.props.isActive, lastLoginAt: null, mustChangePassword: user.props.mustChangePassword };
    });
    await this.publish(AuthEvents.userCreatedWelcome(actor.companyId, result.id, result.email));
    return result;
  }

  async patchUser(userId: string, actor: Actor, dto: {
    name?: string; roleId?: string; financialYearId?: string; phone?: string; version: number;
  }) {
    let roleChanged = false;
    const result = await this.uow.run(async () => {
      const user = await this.users.findById(userId);
      if (!user || user.props.companyId !== actor.companyId) throw new NotFoundException('User not found');
      if (user.props.version !== dto.version) throw new ConflictException('OPTIMISTIC_LOCK_CONFLICT');

      const before = { name: user.props.name, role: user.props.role, phone: user.props.phone };
      const roleName = dto.roleId
        ? (await this.roles.findById(dto.roleId, actor.companyId))?.props.name ?? user.props.role
        : user.props.role;
      roleChanged = roleName !== user.props.role;
      const { User } = await import('../domain/user');
      const updated = User.rehydrate(user.id, {
        ...user.props,
        name: dto.name ?? user.props.name,
        role: roleName,
        financialYearId: dto.financialYearId ?? user.props.financialYearId,
        phone: dto.phone !== undefined ? dto.phone ?? null : user.props.phone,
      });
      await this.users.save(updated);
      const after = { name: updated.props.name, role: updated.props.role, phone: updated.props.phone };
      await this.audit.record({
        action: 'UPDATE', entityType: 'User', entityId: userId,
        actorId: actor.userId, companyId: actor.companyId, before, after,
      });
      return { id: updated.id, email: updated.props.email, name: updated.props.name, role: updated.props.role, isActive: updated.props.isActive };
    });
    if (roleChanged) await this.publish(AuthEvents.rolePermissionsChanged(actor.companyId, userId, actor.userId));
    return result;
  }

  async activateUser(userId: string, actor: Actor): Promise<{ id: string; isActive: boolean }> {
    return this.uow.run(async () => {
      const user = await this.users.findById(userId);
      if (!user || user.props.companyId !== actor.companyId) throw new NotFoundException('User not found');
      user.activate();
      await this.users.save(user);
      await this.audit.record({
        action: 'ACTIVATE' as any, entityType: 'User', entityId: userId,
        actorId: actor.userId, companyId: actor.companyId, before: { isActive: false }, after: { isActive: true },
      });
      return { id: userId, isActive: true };
    });
  }

  async deactivateUser(userId: string, actor: Actor): Promise<{ id: string; isActive: boolean }> {
    const result = await this.uow.run(async () => {
      const user = await this.users.findById(userId);
      if (!user || user.props.companyId !== actor.companyId) throw new NotFoundException('User not found');
      user.deactivate();
      await this.users.save(user);
      await this.store.revokeAllFor(userId);
      await this.audit.record({
        action: 'DEACTIVATE' as any, entityType: 'User', entityId: userId,
        actorId: actor.userId, companyId: actor.companyId, before: { isActive: true }, after: { isActive: false },
      });
      return { id: userId, isActive: false };
    });
    await this.publish(AuthEvents.userDeactivated(actor.companyId, userId, actor.userId));
    return result;
  }

  async resetPassword(userId: string, actor: Actor, dto: { temporaryPassword: string }): Promise<void> {
    await this.uow.run(async () => {
      const user = await this.users.findById(userId);
      if (!user || user.props.companyId !== actor.companyId) throw new NotFoundException('User not found');
      if (dto.temporaryPassword.length < 10) throw new Error('Password must be at least 10 characters');
      const hash = await this.hasher.hash(dto.temporaryPassword);
      user.changePasswordHash(hash);
      user.markMustChangePassword(); // Admin reset re-arms the forced-change gate (FR-AUD-030)
      await this.users.save(user);
      await this.store.revokeAllFor(userId);
      await this.audit.record({
        action: 'UPDATE', entityType: 'User', entityId: userId,
        actorId: actor.userId, companyId: actor.companyId,
        before: { passwordHash: '[REDACTED]' }, after: { passwordHash: '[REDACTED]' },
      });
    });
    await this.publish(AuthEvents.passwordResetForced(actor.companyId, userId, actor.userId));
  }
}
