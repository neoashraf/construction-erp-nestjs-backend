import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Role, RoleProps } from '../domain/role.entity';
import { RoleRepository } from '../domain/ports/role.repository.port';
import { RoleOrmEntity } from './role.orm-entity';
import { assertRoleName, RoleName } from '../domain/role';

@Injectable()
export class TypeOrmRoleRepository implements RoleRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(RoleOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<Role | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  async findByName(companyId: string, name: RoleName): Promise<Role | null> {
    const r = await this.repo().findOne({ where: { companyId, name } });
    return r ? toDomain(r) : null;
  }

  async findAll(companyId: string): Promise<Role[]> {
    const rows = await this.repo().find({ where: { companyId } });
    return rows.map(toDomain);
  }

  async save(role: Role): Promise<void> {
    const p = role.props;
    const existing = await this.repo().findOne({ where: { id: role.id } });
    if (existing) {
      await this.repo().update({ id: role.id }, {
        approvalLimit: p.approvalLimit,
        isUnscoped: p.isUnscoped,
        version: p.version,
      });
    } else {
      await this.repo().insert({
        id: role.id,
        companyId: p.companyId,
        name: p.name,
        approvalLimit: p.approvalLimit,
        isUnscoped: p.isUnscoped,
        version: p.version,
      });
    }
  }
}

function toDomain(r: RoleOrmEntity): Role {
  const props: RoleProps = {
    companyId: r.companyId,
    name: assertRoleName(r.name),
    approvalLimit: r.approvalLimit,
    isUnscoped: r.isUnscoped,
    version: r.version,
  };
  return Role.rehydrate(r.id, props);
}
