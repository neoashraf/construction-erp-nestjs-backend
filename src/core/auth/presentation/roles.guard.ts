/**
 * RolesGuard (PRESENTATION) — checks the actor's role holds the required (resource, action) grant.
 * Reads requirements from @RequirePermission() metadata on the route handler (AUD RBAC v2).
 * FR-AUD-012/013/035, edge case 2.
 *
 * Note: @UseGuards(JwtAuthGuard, RolesGuard) — JwtAuthGuard must run first to populate request.user.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Actor } from '../../tenancy/tenant-context';
import { PermissionRequirement, PERMISSION_KEY } from './require-permission.decorator';
import { PermissionRepository, PERMISSION_REPOSITORY } from '../domain/ports/permission.repository.port';
import { RoleRepository, ROLE_REPOSITORY } from '../domain/ports/role.repository.port';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(PERMISSION_REPOSITORY) private readonly permissions: PermissionRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirements: PermissionRequirement[] | undefined = this.reflector.getAllAndOverride(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requirements || requirements.length === 0) {
      return true; // no @RequirePermission → route is open to any authenticated user
    }

    const request = context.switchToHttp().getRequest();
    const actor: Actor = request.user;
    if (!actor) {
      throw new ForbiddenException('FORBIDDEN');
    }

    const role = await this.roles.findByName(actor.companyId, actor.role);
    if (!role) {
      throw new ForbiddenException('FORBIDDEN');
    }

    const perms = await this.permissions.findByRoleId(role.id, actor.companyId);
    const permSet = new Set(perms.map(p => `${p.props.resource}:${p.props.action}`));

    for (const req of requirements) {
      if (!permSet.has(`${req.resource}:${req.action}`)) {
        throw new ForbiddenException('FORBIDDEN');
      }
    }
    return true;
  }
}
