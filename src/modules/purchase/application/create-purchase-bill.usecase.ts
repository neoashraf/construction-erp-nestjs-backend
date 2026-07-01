/**
 * CreatePurchaseBillUseCase — save a Purchase Bill DRAFT (no ledger, no stock, no number — FR-PUR-004).
 * Inside one uow.run:
 *   1. PM project scope (AccessPolicy, F4);
 *   2. if purchaseOrderId set, load the PO and assertBillable() (APPROVED/PARTIALLY_* only — AC13,
 *      409 PO_NOT_BILLABLE);
 *   3. read tax rates (MAS config) and build the pure PurchaseBill aggregate (figures + residual net
 *      payable computed here);
 *   4. CC TagConsistency: purpose/godown belong to each line's project (FR-CC-004 -> CROSS_PROJECT_DIMENSION,
 *      may reject) — before persisting;
 *   5. insert.
 * Then (advisory, never blocks) run CC's BudgetCheck on the bill's cost lines and surface OK/APPROACHING/
 * OVER/UNBUDGETED (FR-PUR-019; FR-CC-013/-014). No ledger / no stock touch in this use case.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
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
import { NewPurchaseBill, PurchaseBill } from '../domain/purchase-bill';
import { PURCHASE_BILL_REPOSITORY, PurchaseBillRepository } from '../domain/ports/purchase-bill.repository';
import { PURCHASE_ORDER_REPOSITORY, PurchaseOrderRepository } from '../domain/ports/purchase-order.repository';
import { PURCHASE_CONFIG_PORT, PurchaseConfigPort } from '../domain/ports/purchase-config.port';

export interface CreatePurchaseBillResult {
  id: string;
  budgetWarnings: ProspectiveResult[];
}

@Injectable()
export class CreatePurchaseBillUseCase {
  constructor(
    @Inject(PURCHASE_BILL_REPOSITORY) private readonly repo: PurchaseBillRepository,
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly pos: PurchaseOrderRepository,
    @Inject(PURCHASE_CONFIG_PORT) private readonly config: PurchaseConfigPort,
    @Inject(TAG_CONSISTENCY_SERVICE) private readonly tagConsistency: TagConsistencyService,
    @Inject(BUDGET_CHECK_SERVICE) private readonly budgetCheck: BudgetCheckService,
    private readonly access: AccessPolicy,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: NewPurchaseBill, actor: Actor): Promise<CreatePurchaseBillResult> {
    const id = await this.uow.run(async () => {
      try {
        this.access.assertProjectInScope(actor, input.projectId);
      } catch (e) {
        if (e instanceof ForbiddenScopeError) throw new ForbiddenException(e.message);
        throw e;
      }

      if (input.purchaseOrderId) {
        const po = await this.pos.findById(input.purchaseOrderId, actor.companyId);
        if (!po) throw new NotFoundError(`Purchase Order ${input.purchaseOrderId} not found`);
        po.assertBillable();
      }

      const tax = await this.config.taxRates(actor.companyId);
      const bill = PurchaseBill.createDraft(
        this.ids.next(),
        actor.companyId,
        actor.financialYearId,
        input,
        tax,
        input.lines.map(() => this.ids.next()),
      );

      // CC FR-CC-004 — a line's purpose/godown must belong to the bill's project (may reject).
      await this.tagConsistency.assertConsistent(
        { companyId: actor.companyId },
        bill.lines.map((l) => ({ projectId: l.projectId, purposeId: l.purposeId, godownId: l.godownId })),
      );

      await this.repo.insert(bill);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'PurchaseBill',
        entityId: bill.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return bill.id;
    });

    const bill = await this.repo.findById(id, actor.companyId);
    const budgetWarnings = bill
      ? await this.budgetCheck.checkProspective(
          { companyId: actor.companyId, financialYearId: actor.financialYearId },
          bill.costLines(),
        )
      : [];
    return { id, budgetWarnings };
  }
}
