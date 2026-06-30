/** Godown read side — company-scoped; filter by project/active/q. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../../infrastructure/http/pagination';
import { GodownOrmEntity } from '../infrastructure/godown.orm-entity';

export interface GodownDto {
  id: string;
  projectId: string;
  name: string;
  location: string | null;
  isActive: boolean;
  version: number;
}
export interface GodownListFilter extends PageRequest {
  projectId?: string;
  isActive?: boolean;
  q?: string;
}

@Injectable()
export class GodownQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(GodownOrmEntity);
  }

  async list(filter: GodownListFilter, actor: Actor): Promise<Paginated<GodownDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = this.repo().createQueryBuilder('g').where('g.company_id = :c', { c: actor.companyId });
    if (filter.projectId) qb.andWhere('g.project_id = :p', { p: filter.projectId });
    if (filter.isActive !== undefined) qb.andWhere('g.is_active = :a', { a: filter.isActive });
    if (filter.q) qb.andWhere('g.name ILIKE :q', { q: `%${filter.q}%` });
    const [rows, total] = await qb.orderBy('g.name', 'ASC').skip(skip).take(take).getManyAndCount();
    return new Paginated(rows.map(toDto), page, pageSize, total);
  }

  async getById(id: string, actor: Actor): Promise<GodownDto | null> {
    const r = await this.repo().findOne({ where: { id, companyId: actor.companyId } });
    return r ? toDto(r) : null;
  }
}

function toDto(r: GodownOrmEntity): GodownDto {
  return { id: r.id, projectId: r.projectId, name: r.name, location: r.location, isActive: r.isActive, version: r.version };
}
