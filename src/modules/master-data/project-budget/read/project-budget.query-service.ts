/** ProjectBudget read side — list by project, company-scoped. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../../infrastructure/http/pagination';
import { ProjectBudgetOrmEntity } from '../infrastructure/project-budget.orm-entity';

export interface ProjectBudgetDto {
  id: string;
  projectId: string;
  costCentreId: string;
  budgetedAmount: string;
  version: number;
}

@Injectable()
export class ProjectBudgetQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  async listByProject(projectId: string, filter: PageRequest, actor: Actor): Promise<Paginated<ProjectBudgetDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const [rows, total] = await getManager(this.dataSource)
      .getRepository(ProjectBudgetOrmEntity)
      .findAndCount({ where: { projectId, companyId: actor.companyId }, order: { costCentreId: 'ASC' }, skip, take });
    return new Paginated(
      rows.map((r) => ({ id: r.id, projectId: r.projectId, costCentreId: r.costCentreId, budgetedAmount: r.budgetedAmount.toFixed(4), version: r.version })),
      page,
      pageSize,
      total,
    );
  }
}
