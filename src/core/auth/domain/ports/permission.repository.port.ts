import { Permission, ActionCode } from '../permission.entity';

export interface PermissionRepository {
  findById(id: string, companyId: string): Promise<Permission | null>;
  findByRoleId(roleId: string, companyId: string): Promise<Permission[]>;
  findByRoleIdResourceAction(roleId: string, resource: string, action: ActionCode, companyId: string): Promise<Permission | null>;
  findAll(companyId: string, filters?: { roleId?: string; resource?: string; action?: ActionCode }): Promise<Permission[]>;
  save(permission: Permission): Promise<void>;
  delete(id: string, companyId: string): Promise<void>;
  /** Delete every permission of a role (used when deleting a custom role). */
  deleteByRoleId(roleId: string, companyId: string): Promise<void>;
}

export const PERMISSION_REPOSITORY = Symbol('PermissionRepository');
