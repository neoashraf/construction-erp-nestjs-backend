/**
 * PostPurchaseBillUseCase — post a Purchase Bill DRAFT atomically (design §5.2, FR-PUR-008..014). Inside
 * ONE uow.run:
 *   1. row-lock the draft (findByIdForUpdate -> anti-double-post, AC11);
 *   2. assertPostable (DRAFT + >=1 line);
 *   3. if purchaseOrderId set, row-lock + assertBillable() the PO (AC13, 409 PO_NOT_BILLABLE);
 *   4. resolve the purchase accounts (MAS, incl. INV's per-item inventory account via decision 2);
 *   5. --- (a) inventory-in via INV, per stock line, BEFORE the ledger write (FR-PUR-011, AC4) ---
 *      for each stockLine: inventory.receiveIn(ctx, {godownId, itemId, qty, rate}) — rolls avg, writes
 *      movement; PUR computes NO valuation and writes NO stock movement itself;
 *   6. --- (b) ledger via the ONE posting layer ---
 *      buildPurchaseBillCommand -> balanced + fully tagged (§4.1) -> posting.post(cmd) — period->project->
 *      tags->refs->balance->NUMBER(last)->write;
 *   7. markPosted with the allocated gapless PURCHASE number; if against a PO, applyBilledQty per line;
 *   8. save; audit — all inside the ONE uow.run.
 * Any failure rolls everything back — no posted bill, no movement, no entry, NO consumed number (AC5/AC7).
 * `budgetCheck.checkProspective` is called but its result is NEVER allowed to block the post (AC9) —
 * `PostingService` is never consulted about budget.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import {
  BUDGET_CHECK_SERVICE,
  BudgetCheckService,
  ProspectiveResult,
} from '../../../core/cost-control/domain/ports/budget-check.service.port';
import { buildPurchaseBillCommand } from '../domain/bill-posting';
import { PURCHASE_BILL_REPOSITORY, PurchaseBillRepository } from '../domain/ports/purchase-bill.repository';
import { PURCHASE_ORDER_REPOSITORY, PurchaseOrderRepository } from '../domain/ports/purchase-order.repository';
import { PURCHASE_ACCOUNT_MAP_PORT, PurchaseAccountMapPort } from '../domain/ports/purchase-account-map.port';
import {
  PURCHASE_PROJECT_STATUS_PORT,
  PurchaseProjectStatusPort,
} from '../domain/ports/purchase-project-status.port';
import { PURCHASE_INVENTORY_SERVICE } from '../domain/ports/inventory.service.port';
import type { InventoryService } from '../domain/ports/inventory.service.port';

export interface PostPurchaseBillResult {
  entryId: string;
  entryNo: string;
  netPayableAmount: string;
  budgetWarnings: ProspectiveResult[];
}

@Injectable()
export class PostPurchaseBillUseCase {
  constructor(
    @Inject(PURCHASE_BILL_REPOSITORY) private readonly bills: PurchaseBillRepository,
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly pos: PurchaseOrderRepository,
    @Inject(PURCHASE_ACCOUNT_MAP_PORT) private readonly accounts: PurchaseAccountMapPort,
    @Inject(PURCHASE_PROJECT_STATUS_PORT) private readonly projectStatus: PurchaseProjectStatusPort,
    @Inject(PURCHASE_INVENTORY_SERVICE) private readonly inventory: InventoryService,
    @Inject(BUDGET_CHECK_SERVICE) private readonly budgetCheck: BudgetCheckService,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<PostPurchaseBillResult> {
    return this.uow.run(async () => {
      const bill = await this.bills.findByIdForUpdate(id, actor.companyId);
      if (!bill) throw new NotFoundError(`Purchase Bill ${id} not found`);
      bill.assertPostable();
      // Friendly early guard (mirrors HR's HrProjectStatusAdapter precedent) — LED's PostingService ALSO
      // re-checks project status inside posting.post() (FR-PUR-014); this is not the only guard.
      await this.projectStatus.assertNotClosed(actor.companyId, bill.props.projectId);

      if (bill.props.purchaseOrderId) {
        const po = await this.pos.findByIdForUpdate(bill.props.purchaseOrderId, actor.companyId);
        if (!po) throw new NotFoundError(`Purchase Order ${bill.props.purchaseOrderId} not found`);
        po.assertBillable();
      }

      const accountMap = await this.accounts.resolve(actor.companyId);
      const now = this.clock.now();
      const voucherDate = bill.props.billDate;

      // --- (a) inventory-in via INV, per stock line, BEFORE the ledger write (FR-PUR-011, AC4) ---
      for (const line of bill.stockLines()) {
        await this.inventory.receiveIn(
          { companyId: actor.companyId, voucherDate, postedBy: actor.userId },
          {
            godownId: line.godownId as string,
            itemId: line.itemId as string,
            qty: line.billedQty,
            rate: line.rate,
            sourceId: line.id,
          },
        );
      }

      // --- (b) ledger via the ONE posting layer ---
      const cmd = await buildPurchaseBillCommand(bill, accountMap, actor.userId);
      const entry = await this.posting.post(cmd);

      bill.markPosted(entry.id, entry.props.entryNo, actor.userId, now);
      await this.bills.save(bill, bill.version);

      if (bill.props.purchaseOrderId) {
        const po = await this.pos.findByIdForUpdate(bill.props.purchaseOrderId, actor.companyId);
        if (po) {
          // Roll each billed qty into the matching PO line by item (a bill created "from PO" defaults
          // lines from the PO's open lines, so item-matching is stable here; PUR does not carry an
          // explicit po_line_id FK per SRS §8's PurchaseBillLine shape).
          for (const line of bill.stockLines()) {
            const poLine = po.lines.find((pl) => pl.itemId === line.itemId);
            if (poLine) po.applyBilledQty(poLine.lineNo, line.billedQty);
          }
          await this.pos.save(po, po.version);
        }
      }

      await this.audit.record({
        action: 'POST',
        entityType: 'PurchaseBill',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });

      // Advisory over-budget (FR-PUR-019; FR-CC-014) — CALLED but its result NEVER blocks the post
      // (PostingService above never consulted CC). Read after posting so the surfaced status reflects the
      // just-posted actuals; a throw here would be a bug, not an expected path — the AC9 use-case test
      // asserts checkProspective is invoked and its result is ignored for control flow.
      const budgetWarnings = await this.budgetCheck.checkProspective(
        { companyId: actor.companyId, financialYearId: actor.financialYearId },
        bill.costLines(),
      );

      return {
        entryId: entry.id,
        entryNo: entry.props.entryNo,
        netPayableAmount: bill.props.netPayableAmount.amount.toFixed(4),
        budgetWarnings,
      };
    });
  }
}
