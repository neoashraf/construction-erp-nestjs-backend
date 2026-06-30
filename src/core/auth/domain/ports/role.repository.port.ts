import { Role } from '../role.entity';
import { RoleName } from '../role';

export interface RoleRepository {
  findById(id: string, companyId: string): Promise<Role | null>;
  findByName(companyId: string, name: RoleName): Promise<Role | null>;
  findAll(companyId: string): Promise<Role[]>;
  save(role: Role): Promise<void>;
}

export const ROLE_REPOSITORY = Symbol('RoleRepository');
