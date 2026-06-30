/**
 * RBAC use cases (AUD application — FR-AUD-011..020). Wires Role, Permission, UserProjectAssignment
 * mutations. Each mutating use case calls AuditService.record inside uow.run.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { UnitOfWork, UNIT_OF_WORK } from '../../../common/ports/unit-of-work.port';
import { RoleRepository, ROLE_REPOSITORY } from '../domain/ports/role.repository.port';
import { PermissionRepository, PERMISSION_REPOSITORY } from '../domain/ports/permission.repository.port';
import { UserProjectAssignmentRepository, USER_PROJECT_ASSIGNMENT_REPOSITORY } from '../domain/ports/user-project-assignment.repository.port';
import { UserRepository, USER_REPOSITORY } from '../domain/ports/user.repository.port';
import { Permission, ModuleCode, ActionCode, ProjectScope } from '../domain/permission.entity';
import { AUDIT_SERVICE, AuditService } from '../../audit/application/audit.port';
import { Actor } from '../../tenancy/tenant-context';
import { assertRoleName } from '../domain/role';
import { PasswordHasher, PASSWORD_HASHER } from '../domain/ports/password-hasher.port';
import { RefreshTokenStore, REFRESH_TOKEN_STORE } from '../domain/ports/refresh-token-store.port';

// ── Role use cases ──────────────────────────────────────────────────────────

@Injectable()
export class RoleUseCases {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async patchRole(
    id: string,
    actor: Actor,
    dto: { approvalLimit?: string | null; isUnscoped?: boolean; version: number },
  ): Promise<{ id: string; name: string; approvalLimit: string | null; isUnscoped: boolean; version: number }> {
    return this.uow.run(async () => {
      const role = await this.roles.findById(id, actor.companyId);
      if (!role) throw new NotFoundException('Role not found');
      if (role.props.version !== dto.version) throw new ConflictException('OPTIMISTIC_LOCK_CONFLICT');

      const updates: { approvalLimit?: Decimal | null; isUnscoped?: boolean } = {};
      if (dto.approvalLimit !== undefined) {
        updates.approvalLimit = dto.approvalLimit !== null ? new Decimal(dto.approvalLimit) : null;
      }
      if (dto.isUnscoped !== undefined) updates.isUnscoped = dto.isUnscoped;

      const { before, after } = role.patch(updates);
      await this.roles.save(role);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'Role',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: before as Record<string, unknown>,
        after: after as Record<string, unknown>,
      });
      const p = role.props;
      return { id: role.id, name: p.name, approvalLimit: p.approvalLimit?.toFixed(4) ?? null, isUnscoped: p.isUnscoped, version: p.version };
    });
  }
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
    dto: { roleId: string; module: ModuleCode; action: ActionCode; projectScope: ProjectScope; valueLimit?: string | null },
  ): Promise<{ id: string; roleId: string; module: string; action: string; projectScope: string; valueLimit: string | null }> {
    return this.uow.run(async () => {
      const role = await this.roles.findById(dto.roleId, actor.companyId);
      if (!role) throw new NotFoundException('Role not found');

      const existing = await this.permissions.findByRoleIdModuleAction(dto.roleId, dto.module, dto.action, actor.companyId);
      if (existing) throw new ConflictException('DUPLICATE_PERMISSION');

      const perm = Permission.create(crypto.randomUUID(), {
        roleId: dto.roleId,
        companyId: actor.companyId,
        module: dto.module,
        action: dto.action,
        projectScope: dto.projectScope,
        valueLimit: dto.valueLimit != null ? new Decimal(dto.valueLimit) : null,
      });
      await this.permissions.save(perm);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'Permission',
        entityId: perm.id,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: null,
        after: { module: dto.module, action: dto.action, projectScope: dto.projectScope },
      });
      const p = perm.props;
      return { id: perm.id, roleId: p.roleId, module: p.module, action: p.action, projectScope: p.projectScope, valueLimit: p.valueLimit?.toFixed(4) ?? null };
    });
  }

  async patchPermission(
    id: string,
    actor: Actor,
    dto: { projectScope?: ProjectScope; valueLimit?: string | null; version: number },
  ): Promise<{ id: string; module: string; action: string; projectScope: string; valueLimit: string | null }> {
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
        action: 'UPDATE',
        entityType: 'Permission',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: before as Record<string, unknown>,
        after: after as Record<string, unknown>,
      });
      const p = perm.props;
      return { id: perm.id, module: p.module, action: p.action, projectScope: p.projectScope, valueLimit: p.valueLimit?.toFixed(4) ?? null };
    });
  }

  async deletePermission(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const perm = await this.permissions.findById(id, actor.companyId);
      if (!perm) throw new NotFoundException('Permission not found');
      const before = { module: perm.props.module, action: perm.props.action, projectScope: perm.props.projectScope };
      await this.permissions.delete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE' as any,
        entityType: 'Permission',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
        before,
        after: null,
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
      const role = await this.roles.findByName(actor.companyId, assertRoleName(user.props.role));
      if (role?.props.isUnscoped) throw new ConflictException('ROLE_SCOPE_CONFLICT');

      const { added, removed } = await this.assignments.replaceSet(userId, actor.companyId, projectIds);
      for (const projectId of added) {
        await this.audit.record({
          action: 'CREATE',
          entityType: 'UserProjectAssignment',
          entityId: `${userId}:${projectId}`,
          actorId: actor.userId,
          companyId: actor.companyId,
          before: null,
          after: { userId, projectId },
        });
      }
      for (const projectId of removed) {
        await this.audit.record({
          action: 'DELETE' as any,
          entityType: 'UserProjectAssignment',
          entityId: `${userId}:${projectId}`,
          actorId: actor.userId,
          companyId: actor.companyId,
          before: { userId, projectId },
          after: null,
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
        action: 'DELETE' as any,
        entityType: 'UserProjectAssignment',
        entityId: `${userId}:${projectId}`,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: { userId, projectId },
        after: null,
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
  ) {}

  async createUser(actor: Actor, dto: {
    email: string; name: string; roleId: string; financialYearId: string;
    phone?: string; temporaryPassword: string; isActive?: boolean;
  }) {
    return this.uow.run(async () => {
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
        action: 'CREATE',
        entityType: 'User',
        entityId: user.id,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: null,
        after: { email: user.props.email, name: user.props.name, role: user.props.role },
      });
      return { id: user.id, email: user.props.email, name: user.props.name, role: user.props.role, isActive: user.props.isActive, lastLoginAt: null };
    });
  }

  async patchUser(userId: string, actor: Actor, dto: {
    name?: string; roleId?: string; financialYearId?: string; phone?: string; version: number;
  }) {
    return this.uow.run(async () => {
      const user = await this.users.findById(userId);
      if (!user || user.props.companyId !== actor.companyId) throw new NotFoundException('User not found');
      if (user.props.version !== dto.version) throw new ConflictException('OPTIMISTIC_LOCK_CONFLICT');

      const before = { name: user.props.name, role: user.props.role, phone: user.props.phone };
      // We mutate via changePasswordHash/deactivate/activate; for name/role/phone we need to add a patch method
      // For simplicity, directly update via repository
      const roleName = dto.roleId
        ? (await this.roles.findById(dto.roleId, actor.companyId))?.props.name ?? user.props.role
        : user.props.role;
      const { User } = await import('../domain/user');
      const updated = User.rehydrate(user.id, {
        ...user.props,
        name: dto.name ?? user.props.name,
        role: assertRoleName(roleName),
        financialYearId: dto.financialYearId ?? user.props.financialYearId,
        phone: dto.phone !== undefined ? dto.phone ?? null : user.props.phone,
      });
      await this.users.save(updated);
      const after = { name: updated.props.name, role: updated.props.role, phone: updated.props.phone };
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'User',
        entityId: userId,
        actorId: actor.userId,
        companyId: actor.companyId,
        before,
        after,
      });
      return { id: updated.id, email: updated.props.email, name: updated.props.name, role: updated.props.role, isActive: updated.props.isActive };
    });
  }

  async activateUser(userId: string, actor: Actor): Promise<{ id: string; isActive: boolean }> {
    return this.uow.run(async () => {
      const user = await this.users.findById(userId);
      if (!user || user.props.companyId !== actor.companyId) throw new NotFoundException('User not found');
      user.activate();
      await this.users.save(user);
      await this.audit.record({
        action: 'ACTIVATE' as any,
        entityType: 'User',
        entityId: userId,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: { isActive: false },
        after: { isActive: true },
      });
      return { id: userId, isActive: true };
    });
  }

  async deactivateUser(userId: string, actor: Actor): Promise<{ id: string; isActive: boolean }> {
    return this.uow.run(async () => {
      const user = await this.users.findById(userId);
      if (!user || user.props.companyId !== actor.companyId) throw new NotFoundException('User not found');
      user.deactivate();
      await this.users.save(user);
      await this.store.revokeAllFor(userId);
      await this.audit.record({
        action: 'DEACTIVATE' as any,
        entityType: 'User',
        entityId: userId,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: { isActive: true },
        after: { isActive: false },
      });
      return { id: userId, isActive: false };
    });
  }

  async resetPassword(userId: string, actor: Actor, dto: { temporaryPassword: string }): Promise<void> {
    await this.uow.run(async () => {
      const user = await this.users.findById(userId);
      if (!user || user.props.companyId !== actor.companyId) throw new NotFoundException('User not found');
      if (dto.temporaryPassword.length < 10) throw new Error('Password must be at least 10 characters');
      const hash = await this.hasher.hash(dto.temporaryPassword);
      user.changePasswordHash(hash);
      await this.users.save(user);
      await this.store.revokeAllFor(userId);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'User',
        entityId: userId,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: { passwordHash: '[REDACTED]' },
        after: { passwordHash: '[REDACTED]' },
      });
    });
  }
}
