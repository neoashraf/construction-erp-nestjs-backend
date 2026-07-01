/**
 * CreateRequisitionUseCase — save a requisition DRAFT (no number, no ledger, no stock — FR-REQ-001).
 * Inside one uow.run:
 *   1. assert the requester is assigned to the project (AccessPolicy, F4);
 *   2. assert the project is not CLOSED + the cost centre is active (any active company CC — FR-REQ-002/-004);
 *   3. assert each line's item is active + resolve its base UoM (FR-REQ-004);
 *   4. assert the from_godown (if set) is active + belongs to the project (FR-REQ-003/-004);
 *   5. CC TagConsistency: purpose/godown belong to the project (FR-CC-004 → CROSS_PROJECT_DIMENSION);
 *   6. build the pure Requisition aggregate + insert.
 * Then (post-commit-safe, advisory only) run the CC BudgetCheck on the estimated cost lines and surface the
 * OK/APPROACHING/OVER/UNBUDGETED status WITHOUT blocking (FR-CC-013/-014). This brief writes NO ledger
 * entry and moves NO stock — asserted by the test.
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { ForbiddenError } from './errors';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { AccessPolicy, ForbiddenScopeError } from '../../../core/auth/domain/access-policy';
import {
  BUDGET_CHECK_SERVICE,
  BudgetCheckService,
  ProspectiveResult,
} from '../../../core/cost-control/domain/ports/budget-check.service.port';
import {
  TAG_CONSISTENCY_SERVICE,
  TagConsistencyService,
} from '../../../core/cost-control/domain/ports/tag-consistency.port';
import { NewRequisition, NewRequisitionLine, Requisition } from '../domain/requisition';
import {
  REQUISITION_REPOSITORY,
  RequisitionRepository,
} from '../domain/ports/requisition.repository';
import {
  INDICATIVE_RATE_READ_PORT,
  IndicativeRateReadPort,
} from '../domain/ports/indicative-rate.read.port';
import {
  REQUISITION_MASTER_REF_PORT,
  RequisitionMasterRefPort,
} from '../domain/ports/requisition-master-ref.port';

/** The create input line; the UoM is resolved server-side from the item's base UoM (MAS). */
export interface CreateRequisitionLineInput {
  itemId: string;
  requestedQuantity: string;
}

export interface CreateRequisitionInput {
  projectId: string;
  costCentreId: string;
  purposeId: string;
  fromGodownId?: string | null;
  requiredDate: string;
  priority: NewRequisition['priority'];
  narration?: string | null;
  lines: CreateRequisitionLineInput[];
}

export interface CreateRequisitionResult {
  id: string;
  budgetWarnings: ProspectiveResult[];
}

@Injectable()
export class CreateRequisitionUseCase {
  constructor(
    @Inject(REQUISITION_REPOSITORY) private readonly repo: RequisitionRepository,
    @Inject(REQUISITION_MASTER_REF_PORT) private readonly masters: RequisitionMasterRefPort,
    @Inject(INDICATIVE_RATE_READ_PORT) private readonly rates: IndicativeRateReadPort,
    @Inject(TAG_CONSISTENCY_SERVICE) private readonly tagConsistency: TagConsistencyService,
    @Inject(BUDGET_CHECK_SERVICE) private readonly budgetCheck: BudgetCheckService,
    private readonly access: AccessPolicy,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateRequisitionInput, actor: Actor): Promise<CreateRequisitionResult> {
    const godownId = input.fromGodownId ?? null;
    const id = await this.uow.run(async () => {
      // F4: the requester may only raise for an assigned project.
      try {
        this.access.assertProjectInScope(actor, input.projectId);
      } catch (e) {
        if (e instanceof ForbiddenScopeError) throw new ForbiddenError(e.message);
        throw e;
      }

      await this.masters.assertProjectNotClosed(actor.companyId, input.projectId);
      await this.masters.assertCostCentreActive(actor.companyId, input.costCentreId);
      await this.masters.assertGodownActiveInProject(actor.companyId, godownId, input.projectId);

      // Resolve each line's item (active) + base UoM (MAS).
      const lines: NewRequisitionLine[] = [];
      for (const l of input.lines ?? []) {
        const uom = await this.masters.itemBaseUom(actor.companyId, l.itemId);
        lines.push({ itemId: l.itemId, requestedQuantity: l.requestedQuantity, uom });
      }

      // CC FR-CC-004 — a line's purpose/godown must belong to the requisition's project.
      await this.tagConsistency.assertConsistent(
        { companyId: actor.companyId },
        (lines.length ? lines : [{}]).map(() => ({
          projectId: input.projectId,
          purposeId: input.purposeId,
          godownId,
        })),
      );

      const req = Requisition.createDraft(
        this.ids.next(),
        actor.companyId,
        actor.financialYearId,
        {
          projectId: input.projectId,
          costCentreId: input.costCentreId,
          purposeId: input.purposeId,
          fromGodownId: godownId,
          requiredDate: input.requiredDate,
          priority: input.priority,
          narration: input.narration ?? null,
          lines,
        },
        lines.map(() => this.ids.next()),
      );
      await this.repo.insert(req);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'Requisition',
        entityId: req.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return req.id;
    });

    // Advisory over-budget check (soft; never blocks — FR-CC-013/-014). Estimate the cost lines outside
    // the write tx from indicative rates; surface the classification to the caller.
    const budgetWarnings = await this.budgetWarnings(input, godownId, actor);
    return { id, budgetWarnings };
  }

  private async budgetWarnings(
    input: CreateRequisitionInput,
    godownId: string | null,
    actor: Actor,
  ): Promise<ProspectiveResult[]> {
    let amount = new Decimal(0);
    for (const l of input.lines ?? []) {
      const rate = await this.rates.currentAvgOrLastKnown(actor.companyId, godownId, l.itemId);
      amount = amount.plus(rate.times(new Decimal(l.requestedQuantity || 0)));
    }
    if (amount.isZero()) return [];
    return this.budgetCheck.checkProspective(
      { companyId: actor.companyId, financialYearId: actor.financialYearId },
      [{ projectId: input.projectId, costCentreId: input.costCentreId, amount }],
    );
  }
}
