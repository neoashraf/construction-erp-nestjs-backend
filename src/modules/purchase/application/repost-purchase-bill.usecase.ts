/**
 * RepostPurchaseBillUseCase — append-only correction of a POSTED Purchase Bill (FR-PUR-022, FR-PUR-023;
 * FR-LED-027). Inside ONE uow.run: row-lock the bill, assertPosted, then:
 *   (a) inventory.reverseReceipt(...) per ORIGINAL stock line — undo the original receipt-in;
 *   (b) posting.reverse(originalEntryId, reason) — LED reversal entry, own number;
 *   (c) build the CORRECTED transient PurchaseBill aggregate from the supplied fields (same money math as
 *       create) — inventory.receiveIn(...) per CORRECTED stock line — the corrected receipt-in;
 *   (d) buildPurchaseBillCommand(corrected) -> posting.post(cmd) — the corrected entry, its own number;
 *   (e) re-stamp the persisted bill row: corrected figures + the NEW entry/number, still POSTED; save;
 *       audit.
 * If the corrected post fails after the reversal + reverseReceipt succeeded, EVERYTHING rolls back (one
 * uow.run) — the original stays intact and unreversed (edge case 15). The ORIGINAL entry, number, and
 * movements are never mutated; the reversal + corrected posts each get their own next number.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { EditPurchaseBill, NewPurchaseBill, PurchaseBill } from '../domain/purchase-bill';
import { buildPurchaseBillCommand } from '../domain/bill-posting';
import { PURCHASE_BILL_REPOSITORY, PurchaseBillRepository } from '../domain/ports/purchase-bill.repository';
import { PURCHASE_ACCOUNT_MAP_PORT, PurchaseAccountMapPort } from '../domain/ports/purchase-account-map.port';
import { PURCHASE_CONFIG_PORT, PurchaseConfigPort } from '../domain/ports/purchase-config.port';
import { PURCHASE_INVENTORY_SERVICE } from '../domain/ports/inventory.service.port';
import type { InventoryService } from '../domain/ports/inventory.service.port';

export interface RepostPurchaseBillResult {
  entryId: string;
  entryNo: string;
  reversalEntryId: string;
  reversalEntryNo: string;
  netPayableAmount: string;
}

@Injectable()
export class RepostPurchaseBillUseCase {
  constructor(
    @Inject(PURCHASE_BILL_REPOSITORY) private readonly repo: PurchaseBillRepository,
    @Inject(PURCHASE_ACCOUNT_MAP_PORT) private readonly accounts: PurchaseAccountMapPort,
    @Inject(PURCHASE_CONFIG_PORT) private readonly config: PurchaseConfigPort,
    @Inject(PURCHASE_INVENTORY_SERVICE) private readonly inventory: InventoryService,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(
    id: string,
    patch: EditPurchaseBill,
    reason: string,
    actor: Actor,
  ): Promise<RepostPurchaseBillResult> {
    return this.uow.run(async () => {
      const bill = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!bill) throw new NotFoundError(`Purchase Bill ${id} not found`);
      bill.assertPosted();
      if (!bill.props.journalEntryId) {
        throw new ValidationError(`Purchase Bill ${id} has no ledger entry to reverse`, { id });
      }

      const originalVoucherDate = bill.props.billDate;

      // (a) undo the ORIGINAL receipt-in, per original stock line.
      for (const line of bill.stockLines()) {
        await this.inventory.reverseReceipt(
          { companyId: actor.companyId, voucherDate: originalVoucherDate, postedBy: actor.userId },
          {
            godownId: line.godownId as string,
            itemId: line.itemId as string,
            qty: line.billedQty,
            value: line.lineAmount,
            sourceId: line.id,
          },
        );
      }

      // (b) build the CORRECTED transient aggregate (same id/source; recompute figures on merged fields).
      const tax = await this.config.taxRates(actor.companyId);
      const correctedInput = this.buildCorrected(patch, bill);
      const lineIds = correctedInput.lines.map(() => this.ids.next());
      const corrected = PurchaseBill.createDraft(id, actor.companyId, actor.financialYearId, correctedInput, tax, lineIds);

      // (c) the corrected receipt-in, per corrected stock line — BEFORE the ledger write (mirrors post).
      for (const line of corrected.stockLines()) {
        await this.inventory.receiveIn(
          { companyId: actor.companyId, voucherDate: corrected.props.billDate, postedBy: actor.userId },
          {
            godownId: line.godownId as string,
            itemId: line.itemId as string,
            qty: line.billedQty,
            rate: line.rate,
            sourceId: line.id,
          },
        );
      }

      // (d) reverse (original entry) + post (corrected entry) in the SAME uow.run (FR-LED-027).
      const accountMap = await this.accounts.resolve(actor.companyId);
      const cmd = await buildPurchaseBillCommand(corrected, accountMap, actor.userId);
      const { reversal, reposted } = await this.posting.repost(
        bill.props.journalEntryId,
        actor.companyId,
        reason,
        actor.userId,
        cmd,
      );

      // (e) re-stamp the persisted bill row: corrected figures + the NEW entry/number, still POSTED.
      corrected.markPosted(reposted.id, reposted.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(this.mergePersisted(bill, corrected), bill.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'PurchaseBill',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });

      return {
        entryId: reposted.id,
        entryNo: reposted.props.entryNo,
        reversalEntryId: reversal.id,
        reversalEntryNo: reversal.props.entryNo,
        netPayableAmount: corrected.props.netPayableAmount.amount.toFixed(4),
      };
    });
  }

  /** Merge the patch over the current posted bill's fields to the create-shaped corrected input. */
  private buildCorrected(patch: EditPurchaseBill, bill: PurchaseBill): NewPurchaseBill {
    const p = bill.props;
    return {
      projectId: patch.projectId ?? p.projectId,
      supplierId: patch.supplierId ?? p.supplierId,
      purchaseOrderId: patch.purchaseOrderId !== undefined ? patch.purchaseOrderId : p.purchaseOrderId,
      supplierInvoiceRef:
        patch.supplierInvoiceRef !== undefined ? patch.supplierInvoiceRef : p.supplierInvoiceRef,
      billDate: patch.billDate ?? p.billDate,
      dueDate: patch.dueDate ?? p.dueDate,
      narration: patch.narration !== undefined ? patch.narration : p.narration,
      lines:
        patch.lines ??
        bill.lines.map((l) => ({
          itemId: l.itemId,
          expenseAccountId: l.expenseAccountId,
          isStockLine: l.isStockLine,
          billedQty: l.billedQty,
          rate: l.rate,
          godownId: l.godownId,
          projectId: l.projectId,
          costCentreId: l.costCentreId,
          purposeId: l.purposeId,
          vatInputAmount: l.vatInputAmount,
          tdsAmount: l.tdsAmount,
          aitAmount: l.aitAmount,
        })),
    };
  }

  /** Preserve the persisted row's `version` while carrying the corrected, newly-posted props. */
  private mergePersisted(original: PurchaseBill, corrected: PurchaseBill): PurchaseBill {
    return PurchaseBill.rehydrate(original.id, { ...corrected.props, version: original.version }, [
      ...corrected.lines,
    ]);
  }
}
