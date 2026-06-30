/**
 * @Roles decorator — carries the (module, action) permission requirement for RolesGuard.
 * Usage: @Roles({ module: 'AUD', action: 'READ' })
 * FR-AUD-012/013.
 */
import { SetMetadata } from '@nestjs/common';
import { ModuleCode, ActionCode } from '../domain/permission.entity';

export interface PermissionRequirement {
  module: ModuleCode;
  action: ActionCode;
}

export const ROLES_KEY = 'roles_requirements';
export const Roles = (...requirements: PermissionRequirement[]) => SetMetadata(ROLES_KEY, requirements);
