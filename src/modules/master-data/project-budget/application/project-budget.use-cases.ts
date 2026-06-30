/**
 * ProjectBudget use cases (FR-MAS-007/008). Upsert on the (project, cost_centre) pair and delete.
 * Rejects a CLOSED project, an inactive/cross-company cost centre, a negative amount (domain), and a
 * stale version. Audit on mutation.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ClosedProjectError,
  CrossCompanyReferenceError,
  NotFoundError,
  ValidationError,
} from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService, AuditAction } from '../../../../core/audit/application/audit.port';
import { assertVersion } from '../../application/optimistic-lock';
import { TypeOrmProjectRepository } from '../../project/infrastructure/typeorm-project.repository';
import { TypeOrmCostCentreRepository } from '../../cost-centre/infrastructure/typeorm-cost-centre.repository';
import { ProjectBudget } from '../domain/project-budget';
import { TypeOrmProjectBudgetRepository } from '../infrastructure/typeorm-project-budget.repository';

@Injectable()
export class UpsertProjectBudgetUseCase {
  constructor(
    private readonly budgets: TypeOrmProjectBudgetRepository,
    private readonly projects: TypeOrmProjectRepository,
    private readonly costCentres: TypeOrmCostCentreRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(
    projectId: string,
    input: { costCentreId: string; budgetedAmount: string; version?: number },
    actor: Actor,
  ): Promise<{ id: string }> {
    return this.uow.run(async () => {
      const status = await this.projects.statusOf(projectId, actor.companyId);
      if (!status) throw new NotFoundError(`Project ${projectId} not found`);
      if (status === 'CLOSED') throw new ClosedProjectError(projectId);

      const cc = await this.costCentres.findById(input.costCentreId, actor.companyId);
      if (!cc) throw new CrossCompanyReferenceError('cost centre does not belong to the company', { costCentreId: input.costCentreId });
      if (!cc.props.isActive) throw new ValidationError('cost centre is inactive', { costCentreId: input.costCentreId });

      const existing = await this.budgets.findByPair(projectId, input.costCentreId, actor.companyId);
      if (existing) {
        if (input.version === undefined) throw new ValidationError('version is required to update an existing budget');
        assertVersion(existing.version, input.version, 'ProjectBudget', existing.id);
        existing.setAmount(input.budgetedAmount);
        await this.budgets.update(existing, input.version);
        await rec(this.audit, 'UPDATE', existing.id, actor);
        return { id: existing.id };
      }
      const budget = ProjectBudget.create(
        { companyId: actor.companyId, projectId, costCentreId: input.costCentreId, budgetedAmount: input.budgetedAmount },
        this.ids,
      );
      await this.budgets.insert(budget);
      await rec(this.audit, 'CREATE', budget.id, actor);
      return { id: budget.id };
    });
  }
}

@Injectable()
export class DeleteProjectBudgetUseCase {
  constructor(
    private readonly budgets: TypeOrmProjectBudgetRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const ok = await this.budgets.deleteById(id, actor.companyId);
      if (!ok) throw new NotFoundError(`Project budget ${id} not found`);
      await rec(this.audit, 'DEACTIVATE', id, actor);
    });
  }
}

function rec(audit: AuditService, action: AuditAction, id: string, actor: Actor): Promise<void> {
  return audit.record({ action, entityType: 'ProjectBudget', entityId: id, actorId: actor.userId, companyId: actor.companyId });
}
