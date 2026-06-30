import { Permission, ModuleCode, ActionCode } from '../permission.entity';

export interface PermissionRepository {
  findById(id: string, companyId: string): Promise<Permission | null>;
  findByRoleId(roleId: string, companyId: string): Promise<Permission[]>;
  findByRoleIdModuleAction(roleId: string, module: ModuleCode, action: ActionCode, companyId: string): Promise<Permission | null>;
  findAll(companyId: string, filters?: { roleId?: string; module?: ModuleCode; action?: ActionCode }): Promise<Permission[]>;
  save(permission: Permission): Promise<void>;
  delete(id: string, companyId: string): Promise<void>;
}

export const PERMISSION_REPOSITORY = Symbol('PermissionRepository');
