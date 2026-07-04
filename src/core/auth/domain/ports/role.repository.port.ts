import { Role } from '../role.entity';

export interface RoleRepository {
  findById(id: string, companyId: string): Promise<Role | null>;
  findByName(companyId: string, name: string): Promise<Role | null>;
  findAll(companyId: string): Promise<Role[]>;
  /** Insert a new role or update name/approvalLimit/isUnscoped of an existing one. */
  save(role: Role): Promise<void>;
  /** Hard-delete a role (custom only — the use case enforces is_system + ROLE_IN_USE first). */
  delete(id: string, companyId: string): Promise<void>;
  /** Count users referencing this role by name (drives userCount + the ROLE_IN_USE guard). */
  countUsers(companyId: string, name: string): Promise<number>;
  /** Cascade a role rename to `user.role` rows (users reference the role by name string). */
  renameUserReferences(companyId: string, oldName: string, newName: string): Promise<void>;
}

export const ROLE_REPOSITORY = Symbol('RoleRepository');
