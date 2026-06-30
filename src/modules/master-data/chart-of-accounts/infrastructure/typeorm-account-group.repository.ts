/** TypeOrmAccountGroupRepository (INFRASTRUCTURE) — company-scoped, version-guarded. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { versionedUpdate } from '../../shared/repo-helpers';
import { AccountType } from '../domain/account-type';
import { AccountGroup } from '../domain/account-group';
import { AccountGroupOrmEntity } from './account-group.orm-entity';

@Injectable()
export class TypeOrmAccountGroupRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(AccountGroupOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<AccountGroup | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  /** The group's type for the account `type == group.type` gate (FR-MAS-019); null if not in company. */
  async typeOf(id: string, companyId: string): Promise<AccountType | null> {
    const r = await this.repo().findOne({ where: { id, companyId }, select: { id: true, type: true } });
    return r ? (r.type as AccountType) : null;
  }

  async insert(g: AccountGroup): Promise<void> {
    const p = g.props;
    await this.repo().insert({
      id: g.id,
      companyId: p.companyId,
      name: p.name,
      parentGroupId: p.parentGroupId,
      type: p.type,
    });
  }

  async update(g: AccountGroup, expectedVersion: number): Promise<void> {
    const p = g.props;
    await versionedUpdate(this.repo(), AccountGroupOrmEntity, g.id, p.companyId, expectedVersion, {
      name: p.name,
      parentGroupId: p.parentGroupId,
    });
  }

  /** Map of existing group `name → id` for this company — lets the seed reuse groups idempotently. */
  async namesToIds(companyId: string): Promise<Map<string, string>> {
    const rows = await this.repo().find({ where: { companyId }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.name, r.id]));
  }

  /** Idempotent seed — ON CONFLICT (id) DO NOTHING (the seed reuses existing ids per company+name). */
  async seedIfAbsent(g: AccountGroup): Promise<void> {
    const p = g.props;
    await getManager(this.dataSource).query(
      `INSERT INTO account_group (id, company_id, name, parent_group_id, type) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [g.id, p.companyId, p.name, p.parentGroupId, p.type],
    );
  }
}

function toDomain(r: AccountGroupOrmEntity): AccountGroup {
  return AccountGroup.rehydrate(r.id, {
    companyId: r.companyId,
    name: r.name,
    parentGroupId: r.parentGroupId,
    type: r.type as AccountType,
    version: r.version,
  });
}
