/** Project read side — DTOs straight from SQL, company-scoped (skill §2.3). */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../../infrastructure/http/pagination';
import { ProjectOrmEntity } from '../infrastructure/project.orm-entity';

export interface ProjectDto {
  id: string;
  projectCode: string;
  name: string;
  location: string | null;
  customerId: string;
  projectManagerId: string;
  startDate: string;
  expectedEndDate: string;
  actualEndDate: string | null;
  status: string;
  version: number;
}
export interface ProjectListFilter extends PageRequest {
  status?: string;
  customerId?: string;
  projectManagerId?: string;
  q?: string;
}

@Injectable()
export class ProjectQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(ProjectOrmEntity);
  }

  async list(filter: ProjectListFilter, actor: Actor): Promise<Paginated<ProjectDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = this.repo().createQueryBuilder('p').where('p.company_id = :c', { c: actor.companyId });
    if (filter.status) qb.andWhere('p.status = :s', { s: filter.status });
    if (filter.customerId) qb.andWhere('p.customer_id = :cu', { cu: filter.customerId });
    if (filter.projectManagerId) qb.andWhere('p.project_manager_id = :pm', { pm: filter.projectManagerId });
    if (filter.q) qb.andWhere('(p.project_code ILIKE :q OR p.name ILIKE :q)', { q: `%${filter.q}%` });
    const [rows, total] = await qb.orderBy('p.project_code', 'ASC').skip(skip).take(take).getManyAndCount();
    return new Paginated(rows.map(toDto), page, pageSize, total);
  }

  async getById(id: string, actor: Actor): Promise<ProjectDto | null> {
    const r = await this.repo().findOne({ where: { id, companyId: actor.companyId } });
    return r ? toDto(r) : null;
  }
}

function toDto(r: ProjectOrmEntity): ProjectDto {
  return {
    id: r.id,
    projectCode: r.projectCode,
    name: r.name,
    location: r.location,
    customerId: r.customerId,
    projectManagerId: r.projectManagerId,
    startDate: r.startDate,
    expectedEndDate: r.expectedEndDate,
    actualEndDate: r.actualEndDate,
    status: r.status,
    version: r.version,
  };
}
