/** TypeOrmProjectBudgetRepository (INFRASTRUCTURE) — keyed on (project, cost_centre); version-guarded. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Money } from '../../../../common/money';
import { versionedUpdate } from '../../shared/repo-helpers';
import { ProjectBudget } from '../domain/project-budget';
import { ProjectBudgetOrmEntity } from './project-budget.orm-entity';

@Injectable()
export class TypeOrmProjectBudgetRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(ProjectBudgetOrmEntity);
  }

  async findByPair(projectId: string, costCentreId: string, companyId: string): Promise<ProjectBudget | null> {
    const r = await this.repo().findOne({ where: { projectId, costCentreId, companyId } });
    return r ? toDomain(r) : null;
  }
  async findById(id: string, companyId: string): Promise<ProjectBudget | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }
  async insert(b: ProjectBudget): Promise<void> {
    const p = b.props;
    await this.repo().insert({ id: b.id, companyId: p.companyId, projectId: p.projectId, costCentreId: p.costCentreId, budgetedAmount: p.budgetedAmount.amount });
  }
  async update(b: ProjectBudget, expectedVersion: number): Promise<void> {
    await versionedUpdate(this.repo(), ProjectBudgetOrmEntity, b.id, b.props.companyId, expectedVersion, {
      budgetedAmount: b.props.budgetedAmount.amount.toFixed(4),
    });
  }
  async deleteById(id: string, companyId: string): Promise<boolean> {
    const res = await this.repo().createQueryBuilder().delete().from(ProjectBudgetOrmEntity).where('id = :id AND company_id = :c', { id, c: companyId }).execute();
    return (res.affected ?? 0) > 0;
  }
}

function toDomain(r: ProjectBudgetOrmEntity): ProjectBudget {
  return ProjectBudget.rehydrate(r.id, {
    companyId: r.companyId,
    projectId: r.projectId,
    costCentreId: r.costCentreId,
    budgetedAmount: Money.of(r.budgetedAmount),
    version: r.version,
  });
}
