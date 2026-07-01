/**
 * CancelPurchaseBillUseCase — append-only cancel of a POSTED Purchase Bill (FR-PUR-022, FR-PUR-023). Inside
 * ONE uow.run: row-lock the bill, assertPosted, `inventory.reverseReceipt(...)` per stock line (mirror OUT
 * movements restoring the prior godown balances — INV's own (godown,item) lock), then
 * `posting.reverse(journalEntryId, reason)` (a NEW linked reversal entry with its OWN gapless number,
 * Dr<->Cr swapped; the original ledger entry and its bill number are never mutated), mark the bill
 * CANCELLED, save, audit. LED rejects reversing an already-reversed entry and a reversal into a closed
 * period/against a closed project.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { PURCHASE_BILL_REPOSITORY, PurchaseBillRepository } from '../domain/ports/purchase-bill.repository';
import { PURCHASE_INVENTORY_SERVICE } from '../domain/ports/inventory.service.port';
import type { InventoryService } from '../domain/ports/inventory.service.port';

export interface CancelPurchaseBillResult {
  reversalEntryId: string;
  reversalEntryNo: string;
}

@Injectable()
export class CancelPurchaseBillUseCase {
  constructor(
    @Inject(PURCHASE_BILL_REPOSITORY) private readonly repo: PurchaseBillRepository,
    @Inject(PURCHASE_INVENTORY_SERVICE) private readonly inventory: InventoryService,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, reason: string, actor: Actor): Promise<CancelPurchaseBillResult> {
    return this.uow.run(async () => {
      const bill = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!bill) throw new NotFoundError(`Purchase Bill ${id} not found`);
      bill.assertPosted();
      if (!bill.props.journalEntryId) {
        throw new ValidationError(`Purchase Bill ${id} has no ledger entry to reverse`, { id });
      }

      const voucherDate = bill.props.billDate;
      for (const line of bill.stockLines()) {
        await this.inventory.reverseReceipt(
          { companyId: actor.companyId, voucherDate, postedBy: actor.userId },
          {
            godownId: line.godownId as string,
            itemId: line.itemId as string,
            qty: line.billedQty,
            value: line.lineAmount,
            sourceId: line.id,
          },
        );
      }

      const reversal = await this.posting.reverse(bill.props.journalEntryId, actor.companyId, reason, actor.userId);
      bill.markCancelled();
      await this.repo.save(bill, bill.version);
      await this.audit.record({
        action: 'CANCEL',
        entityType: 'PurchaseBill',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { reversalEntryId: reversal.id, reversalEntryNo: reversal.props.entryNo };
    });
  }
}
