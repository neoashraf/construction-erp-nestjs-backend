/**
 * @RequirePermission decorator — carries the (resource, action) grant a route needs (AUD RBAC v2).
 * `resource` is a Resource-Catalogue code (screen/feature — see resource-catalog.ts); `action` is an
 * ActionCode. RolesGuard reads this metadata and 403s unless the caller's role holds the grant.
 * Usage: @RequirePermission('cost_control.profitability', 'READ')  (FR-AUD-013/035).
 */
import { SetMetadata } from '@nestjs/common';
import { ActionCode } from '../domain/permission.entity';

export interface PermissionRequirement {
  resource: string;
  action: ActionCode;
}

export const PERMISSION_KEY = 'permission_requirements';

export const RequirePermission = (resource: string, action: ActionCode) =>
  SetMetadata(PERMISSION_KEY, [{ resource, action }] as PermissionRequirement[]);
