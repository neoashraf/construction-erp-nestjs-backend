/** CostCentre read side — DTOs straight from SQL, company-scoped (skill §2.3). */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../../infrastructure/http/pagination';
import { CostCentreOrmEntity } from '../infrastructure/cost-centre.orm-entity';

export interface CostCentreDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  version: number;
}
export interface CostCentreListFilter extends PageRequest {
  isActive?: boolean;
  q?: string;
}

@Injectable()
export class CostCentreQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(CostCentreOrmEntity);
  }

  async list(filter: CostCentreListFilter, actor: Actor): Promise<Paginated<CostCentreDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = this.repo()
      .createQueryBuilder('c')
      .where('c.company_id = :companyId', { companyId: actor.companyId });
    if (filter.isActive !== undefined) qb.andWhere('c.is_active = :a', { a: filter.isActive });
    if (filter.q) qb.andWhere('(c.code ILIKE :q OR c.name ILIKE :q)', { q: `%${filter.q}%` });
    const [rows, total] = await qb.orderBy('c.code', 'ASC').skip(skip).take(take).getManyAndCount();
    return new Paginated(rows.map(toDto), page, pageSize, total);
  }

  async getById(id: string, actor: Actor): Promise<CostCentreDto | null> {
    const r = await this.repo().findOne({ where: { id, companyId: actor.companyId } });
    return r ? toDto(r) : null;
  }
}

function toDto(r: CostCentreOrmEntity): CostCentreDto {
  return { id: r.id, code: r.code, name: r.name, isActive: r.isActive, version: r.version };
}
