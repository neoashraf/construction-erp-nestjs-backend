/**
 * CreatePurchaseOrderUseCase — save a PO DRAFT (no ledger, no stock, no number — FR-PUR-001). Inside one
 * uow.run:
 *   1. PM project scope (AccessPolicy, F4);
 *   2. CC TagConsistency: purpose/godown belong to the PO's project (FR-CC-004 -> CROSS_PROJECT_DIMENSION);
 *   3. build the pure PurchaseOrder aggregate + insert.
 * Then (advisory, never blocks) run CC's BudgetCheck on the line values and surface OK/APPROACHING/OVER/
 * UNBUDGETED (FR-PUR-019; FR-CC-013/-014). A PO writes NO ledger entry and moves NO stock (FR-PUR-001).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import Decimal from 'decimal.js';
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
import { NewPurchaseOrder, PurchaseOrder } from '../domain/purchase-order';
import { PURCHASE_ORDER_REPOSITORY, PurchaseOrderRepository } from '../domain/ports/purchase-order.repository';

export interface CreatePurchaseOrderResult {
  id: string;
  budgetWarnings: ProspectiveResult[];
}

@Injectable()
export class CreatePurchaseOrderUseCase {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly repo: PurchaseOrderRepository,
    @Inject(TAG_CONSISTENCY_SERVICE) private readonly tagConsistency: TagConsistencyService,
    @Inject(BUDGET_CHECK_SERVICE) private readonly budgetCheck: BudgetCheckService,
    private readonly access: AccessPolicy,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: NewPurchaseOrder, actor: Actor): Promise<CreatePurchaseOrderResult> {
    const id = await this.uow.run(async () => {
      try {
        this.access.assertProjectInScope(actor, input.projectId);
      } catch (e) {
        if (e instanceof ForbiddenScopeError) throw new ForbiddenException(e.message);
        throw e;
      }

      await this.tagConsistency.assertConsistent(
        { companyId: actor.companyId },
        input.lines.map((l) => ({ projectId: l.projectId, purposeId: l.purposeId, godownId: l.godownId })),
      );

      const po = PurchaseOrder.createDraft(
        this.ids.next(),
        actor.companyId,
        actor.financialYearId,
        input,
        input.lines.map(() => this.ids.next()),
      );
      await this.repo.insert(po);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'PurchaseOrder',
        entityId: po.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return po.id;
    });

    const amount = input.lines.reduce(
      (s, l) => s.plus(new Decimal(l.orderedQty).times(new Decimal(l.rate))),
      new Decimal(0),
    );
    const budgetWarnings = amount.isZero()
      ? []
      : await this.budgetCheck.checkProspective(
          { companyId: actor.companyId, financialYearId: actor.financialYearId },
          [{ projectId: input.projectId, costCentreId: input.lines[0].costCentreId, amount }],
        );
    return { id, budgetWarnings };
  }
}
