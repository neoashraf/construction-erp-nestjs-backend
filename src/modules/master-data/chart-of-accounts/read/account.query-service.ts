/** Account read side — DTOs straight from SQL, company-scoped (skill §2.3). openingBalance as a string. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../../infrastructure/http/pagination';
import { AccountOrmEntity } from '../infrastructure/account.orm-entity';

export interface AccountDto {
  id: string;
  code: string;
  name: string;
  accountGroupId: string;
  type: string;
  openingBalance: string | null;
  isActive: boolean;
  version: number;
}
export interface AccountListFilter extends PageRequest {
  type?: string;
  accountGroupId?: string;
  isActive?: boolean;
  q?: string;
}

@Injectable()
export class AccountQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(AccountOrmEntity);
  }

  async list(filter: AccountListFilter, actor: Actor): Promise<Paginated<AccountDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = this.repo().createQueryBuilder('a').where('a.company_id = :companyId', { companyId: actor.companyId });
    if (filter.type) qb.andWhere('a.type = :t', { t: filter.type });
    if (filter.accountGroupId) qb.andWhere('a.account_group_id = :g', { g: filter.accountGroupId });
    if (filter.isActive !== undefined) qb.andWhere('a.is_active = :act', { act: filter.isActive });
    if (filter.q) qb.andWhere('(a.code ILIKE :q OR a.name ILIKE :q)', { q: `%${filter.q}%` });
    const [rows, total] = await qb.orderBy('a.code', 'ASC').skip(skip).take(take).getManyAndCount();
    return new Paginated(rows.map(toDto), page, pageSize, total);
  }

  async getById(id: string, actor: Actor): Promise<AccountDto | null> {
    const r = await this.repo().findOne({ where: { id, companyId: actor.companyId } });
    return r ? toDto(r) : null;
  }
}

function toDto(r: AccountOrmEntity): AccountDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    accountGroupId: r.accountGroupId,
    type: r.type,
    openingBalance: r.openingBalance == null ? null : r.openingBalance.toFixed(4),
    isActive: r.isActive,
    version: r.version,
  };
}
