/**
 * CreateGrnUseCase — save a GRN DRAFT against a PO and/or Bill (FR-PUR-015, FR-PUR-018). Inside one
 * uow.run:
 *   1. PM project scope (AccessPolicy, F4);
 *   2. if purchaseBillId set, the bill must exist, belong to the company, and match the GRN's
 *      supplier + project (SRS §11); line `purchaseBillLineId` refs must belong to that bill and item;
 *   3. if purchaseOrderId set, the PO must be receivable (APPROVED/PARTIALLY_* — 409 PO_NOT_BILLABLE);
 *   4. lines OMITTED -> default to the referenced bill's open (unreceived) quantities
 *      (billed − Σ received over POSTED GRNs, FR-PUR-018), or the PO's open lines for a PO-only GRN —
 *      the Store Keeper then edits the ACTUAL received quantity (FR-PUR-016);
 *   5. CC TagConsistency: purpose/godown belong to each line's project (400 CROSS_PROJECT_DIMENSION);
 *   6. insert + audit.
 * NO ledger, NO stock, NO number — a GRN draft (and, under the §10 Q4 option-(a) resolution, even a
 * POSTED GRN) never touches them; see grn.ts.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { AccessPolicy, ForbiddenScopeError } from '../../../core/auth/domain/access-policy';
import {
  TAG_CONSISTENCY_SERVICE,
  TagConsistencyService,
} from '../../../core/cost-control/domain/ports/tag-consistency.port';
import { Grn, NewGrn, NewGrnLine } from '../domain/grn';
import { openQtyOf } from '../domain/match';
import { GRN_REPOSITORY, GrnRepository } from '../domain/ports/grn.repository';
import { PURCHASE_BILL_REPOSITORY, PurchaseBillRepository } from '../domain/ports/purchase-bill.repository';
import { PURCHASE_ORDER_REPOSITORY, PurchaseOrderRepository } from '../domain/ports/purchase-order.repository';

/** Lines may be omitted — they then default from the referenced bill/PO's open quantities (FR-PUR-018). */
export type NewGrnInput = Omit<NewGrn, 'lines'> & { lines?: NewGrnLine[] };

@Injectable()
export class CreateGrnUseCase {
  constructor(
    @Inject(GRN_REPOSITORY) private readonly grns: GrnRepository,
    @Inject(PURCHASE_BILL_REPOSITORY) private readonly bills: PurchaseBillRepository,
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly pos: PurchaseOrderRepository,
    @Inject(TAG_CONSISTENCY_SERVICE) private readonly tagConsistency: TagConsistencyService,
    private readonly access: AccessPolicy,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: NewGrnInput, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      try {
        this.access.assertProjectInScope(actor, input.projectId);
      } catch (e) {
        if (e instanceof ForbiddenScopeError) throw new ForbiddenException(e.message);
        throw e;
      }

      const bill = input.purchaseBillId
        ? await this.bills.findById(input.purchaseBillId, actor.companyId)
        : null;
      if (input.purchaseBillId && !bill) {
        throw new NotFoundError(`Purchase Bill ${input.purchaseBillId} not found`);
      }
      if (bill) {
        // SRS §11 — a GRN raised against a bill must match the bill's supplier and project.
        if (bill.props.supplierId !== input.supplierId || bill.props.projectId !== input.projectId) {
          throw new ValidationError('GRN supplier/project must match the referenced Purchase Bill', {
            purchaseBillId: bill.id,
          });
        }
      }
      if (input.purchaseOrderId) {
        const po = await this.pos.findById(input.purchaseOrderId, actor.companyId);
        if (!po) throw new NotFoundError(`Purchase Order ${input.purchaseOrderId} not found`);
        po.assertBillable(); // receivable = billable states (FR-PUR-002; 409 PO_NOT_BILLABLE)
      }

      const lines =
        input.lines && input.lines.length
          ? input.lines
          : await this.defaultLines(input, actor.companyId);

      if (bill) {
        // Each purchaseBillLineId ref must be a line of the referenced bill, same item (SRS §11).
        for (const l of lines) {
          if (!l.purchaseBillLineId) continue;
          const billLine = bill.lines.find((bl) => bl.id === l.purchaseBillLineId);
          if (!billLine || billLine.itemId !== l.itemId) {
            throw new ValidationError(
              'purchaseBillLineId must reference a line of the referenced bill with the same item',
              { purchaseBillLineId: l.purchaseBillLineId },
            );
          }
        }
      }

      const grn = Grn.createDraft(
        this.ids.next(),
        actor.companyId,
        actor.financialYearId,
        { ...input, lines },
        lines.map(() => this.ids.next()),
      );

      // CC FR-CC-004 — a line's purpose/godown must belong to its project (400 CROSS_PROJECT_DIMENSION).
      await this.tagConsistency.assertConsistent(
        { companyId: actor.companyId },
        grn.lines.map((l) => ({ projectId: l.projectId, purposeId: l.purposeId, godownId: l.godownId })),
      );

      await this.grns.insert(grn);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'Grn',
        entityId: grn.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: grn.id };
    });
  }

  /** Default lines to the referenced bill's open (billed − Σ received) or the PO's open lines (FR-PUR-018). */
  private async defaultLines(input: NewGrnInput, companyId: string): Promise<NewGrnLine[]> {
    if (input.purchaseBillId) {
      const bill = await this.bills.findById(input.purchaseBillId, companyId);
      const lines: NewGrnLine[] = [];
      for (const bl of bill?.lines ?? []) {
        if (!bl.isStockLine || !bl.itemId || !bl.godownId) continue; // only stock lines are receivable
        const received = await this.grns.receivedSoFar(bl.id, companyId);
        const open = openQtyOf(bl.billedQty, received);
        if (open.lessThanOrEqualTo(0)) continue;
        lines.push({
          purchaseBillLineId: bl.id,
          itemId: bl.itemId,
          receivedQty: open,
          rate: bl.rate,
          godownId: bl.godownId,
          projectId: bl.projectId,
          costCentreId: bl.costCentreId,
          purposeId: bl.purposeId,
        });
      }
      if (lines.length) return lines;
      throw new ValidationError('The referenced bill has no open (unreceived) stock quantity to default from', {
        purchaseBillId: input.purchaseBillId,
      });
    }
    if (input.purchaseOrderId) {
      const open = await this.pos.openLines(input.purchaseOrderId, companyId);
      const lines: NewGrnLine[] = open
        .filter((ol) => ol.orderedQty.minus(ol.receivedQty).greaterThan(0))
        .map((ol) => ({
          itemId: ol.itemId,
          receivedQty: ol.orderedQty.minus(ol.receivedQty) as Decimal,
          rate: ol.rate,
          godownId: ol.godownId,
          projectId: ol.projectId,
          costCentreId: ol.costCentreId,
          purposeId: ol.purposeId,
        }));
      if (lines.length) return lines;
    }
    throw new ValidationError('A GRN requires lines, or a referenced bill/PO with open quantities to default from', {
      field: 'lines',
    });
  }
}
