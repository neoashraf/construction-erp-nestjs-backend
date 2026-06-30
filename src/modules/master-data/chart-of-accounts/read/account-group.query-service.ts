/** AccountGroup read side — DTOs straight from SQL, company-scoped (skill §2.3). */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../../infrastructure/http/pagination';
import { AccountGroupOrmEntity } from '../infrastructure/account-group.orm-entity';

export interface AccountGroupDto {
  id: string;
  name: string;
  parentGroupId: string | null;
  type: string;
  version: number;
}
export interface AccountGroupListFilter extends PageRequest {
  type?: string;
  parentGroupId?: string;
}

@Injectable()
export class AccountGroupQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(AccountGroupOrmEntity);
  }

  async list(filter: AccountGroupListFilter, actor: Actor): Promise<Paginated<AccountGroupDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = this.repo().createQueryBuilder('g').where('g.company_id = :companyId', { companyId: actor.companyId });
    if (filter.type) qb.andWhere('g.type = :t', { t: filter.type });
    if (filter.parentGroupId) qb.andWhere('g.parent_group_id = :p', { p: filter.parentGroupId });
    const [rows, total] = await qb.orderBy('g.name', 'ASC').skip(skip).take(take).getManyAndCount();
    return new Paginated(rows.map(toDto), page, pageSize, total);
  }

  async getById(id: string, actor: Actor): Promise<AccountGroupDto | null> {
    const r = await this.repo().findOne({ where: { id, companyId: actor.companyId } });
    return r ? toDto(r) : null;
  }
}

function toDto(r: AccountGroupOrmEntity): AccountGroupDto {
  return { id: r.id, name: r.name, parentGroupId: r.parentGroupId, type: r.type, version: r.version };
}
