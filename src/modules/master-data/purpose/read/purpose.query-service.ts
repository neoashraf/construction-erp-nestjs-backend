/** Purpose read side — active-only typeahead list per project, company-scoped. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../../infrastructure/http/pagination';
import { PurposeOrmEntity } from '../infrastructure/purpose.orm-entity';

export interface PurposeDto {
  id: string;
  projectId: string;
  name: string;
  isActive: boolean;
  version: number;
}
export interface PurposeListFilter extends PageRequest {
  isActive?: boolean;
  q?: string;
}

@Injectable()
export class PurposeQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  async listByProject(projectId: string, filter: PurposeListFilter, actor: Actor): Promise<Paginated<PurposeDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(PurposeOrmEntity)
      .createQueryBuilder('p')
      .where('p.project_id = :projectId AND p.company_id = :c', { projectId, c: actor.companyId });
    if (filter.isActive !== undefined) qb.andWhere('p.is_active = :a', { a: filter.isActive });
    if (filter.q) qb.andWhere('p.name ILIKE :q', { q: `%${filter.q}%` });
    const [rows, total] = await qb.orderBy('p.name', 'ASC').skip(skip).take(take).getManyAndCount();
    return new Paginated(
      rows.map((r) => ({ id: r.id, projectId: r.projectId, name: r.name, isActive: r.isActive, version: r.version })),
      page,
      pageSize,
      total,
    );
  }

  async getById(id: string, actor: Actor): Promise<PurposeDto | null> {
    const r = await getManager(this.dataSource).getRepository(PurposeOrmEntity).findOne({ where: { id, companyId: actor.companyId } });
    return r ? { id: r.id, projectId: r.projectId, name: r.name, isActive: r.isActive, version: r.version } : null;
  }
}
