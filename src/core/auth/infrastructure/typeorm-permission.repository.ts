import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Permission, PermissionProps, ActionCode } from '../domain/permission.entity';
import { PermissionRepository } from '../domain/ports/permission.repository.port';
import { PermissionOrmEntity } from './permission.orm-entity';

@Injectable()
export class TypeOrmPermissionRepository implements PermissionRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(PermissionOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<Permission | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  async findByRoleId(roleId: string, companyId: string): Promise<Permission[]> {
    const rows = await this.repo().find({ where: { roleId, companyId } });
    return rows.map(toDomain);
  }

  async findByRoleIdResourceAction(roleId: string, resource: string, action: ActionCode, companyId: string): Promise<Permission | null> {
    const r = await this.repo().findOne({ where: { roleId, resource, action, companyId } });
    return r ? toDomain(r) : null;
  }

  async findAll(companyId: string, filters?: { roleId?: string; resource?: string; action?: ActionCode }): Promise<Permission[]> {
    const where: Record<string, unknown> = { companyId };
    if (filters?.roleId) where.roleId = filters.roleId;
    if (filters?.resource) where.resource = filters.resource;
    if (filters?.action) where.action = filters.action;
    const rows = await this.repo().find({ where });
    return rows.map(toDomain);
  }

  async save(permission: Permission): Promise<void> {
    const p = permission.props;
    const existing = await this.repo().findOne({ where: { id: permission.id } });
    if (existing) {
      await this.repo().update({ id: permission.id }, {
        projectScope: p.projectScope,
        valueLimit: p.valueLimit,
        version: p.version,
      });
    } else {
      await this.repo().insert({
        id: permission.id,
        roleId: p.roleId,
        companyId: p.companyId,
        resource: p.resource,
        action: p.action,
        projectScope: p.projectScope,
        valueLimit: p.valueLimit,
        version: p.version,
      });
    }
  }

  async delete(id: string, companyId: string): Promise<void> {
    await this.repo().delete({ id, companyId });
  }

  async deleteByRoleId(roleId: string, companyId: string): Promise<void> {
    await this.repo().delete({ roleId, companyId });
  }
}

function toDomain(r: PermissionOrmEntity): Permission {
  const props: PermissionProps = {
    roleId: r.roleId,
    companyId: r.companyId,
    resource: r.resource,
    action: r.action,
    projectScope: r.projectScope,
    valueLimit: r.valueLimit,
    version: r.version,
  };
  return Permission.rehydrate(r.id, props);
}
