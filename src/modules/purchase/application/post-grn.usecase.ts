/**
 * PostGrnUseCase — post a GRN DRAFT (FR-PUR-016, FR-PUR-017, FR-PUR-018) under the RESOLVED §10 Q4
 * option (a): "received = billed at bill post" — the GRN is an INFORMATIONAL physical-receipt record
 * (see grn.ts for the full decision record).
 *
 * ── THE OPTION-(a) INVARIANT (the double-count guard) ─────────────────────────────────────────────────
 * This use case deliberately injects NEITHER `InventoryService` NOR `PostingService`: posting a GRN
 * writes ZERO `stock_movement` rows (the bill post already rolled inventory for the billed quantity — a
 * `receiveIn` here would DOUBLE-COUNT stock), ZERO `journal_entry` rows (no GRN-clearing account under
 * option (a)), and consumes ZERO voucher numbers. The stock-ledger ⇄ GL reconciliation (FR-INV-005) of a
 * previously-posted bill is byte-identical before and after a GRN post — asserted by the integration
 * suite. The absence of the INV/LED dependencies is a compile-level guarantee, not just a runtime one.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * What it DOES, inside one uow.run:
 *   1. row-lock the draft (findByIdForUpdate — anti-double-post);
 *   2. assertPostable (DRAFT + ≥1 line);
 *   3. snapshot each line's billed-vs-received match status via match.ts — billed from the referenced
 *      purchase_bill_line, receivedSoFar from Σ POSTED GRNs + this GRN's own line (FR-PUR-017). A line
 *      with no bill-line reference compares against billed = 0 (goods received, nothing billed yet →
 *      OVER_RECEIVED — advisory). Over-delivery NEVER blocks (edge case 6, §10 Q5 default);
 *   4. markPosted -> save -> audit.
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { matchStatusOf, MatchStatus } from '../domain/match';
import { GRN_REPOSITORY, GrnRepository } from '../domain/ports/grn.repository';
import { PURCHASE_BILL_REPOSITORY, PurchaseBillRepository } from '../domain/ports/purchase-bill.repository';

export interface PostGrnResult {
  id: string;
  status: 'POSTED';
  lines: { lineNo: number; matchStatus: MatchStatus }[];
}

@Injectable()
export class PostGrnUseCase {
  // NOTE (option (a), §10 Q4): no InventoryService, no PostingService — by design. See the class doc.
  constructor(
    @Inject(GRN_REPOSITORY) private readonly grns: GrnRepository,
    @Inject(PURCHASE_BILL_REPOSITORY) private readonly bills: PurchaseBillRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<PostGrnResult> {
    return this.uow.run(async () => {
      const grn = await this.grns.findByIdForUpdate(id, actor.companyId);
      if (!grn) throw new NotFoundError(`GRN ${id} not found`);
      grn.assertPostable();

      const bill = grn.props.purchaseBillId
        ? await this.bills.findById(grn.props.purchaseBillId, actor.companyId)
        : null;

      const statuses: { lineNo: number; matchStatus: MatchStatus }[] = [];
      for (const line of grn.lines) {
        let billed = new Decimal(0);
        let receivedBefore = new Decimal(0);
        if (line.purchaseBillLineId) {
          const billLine = bill?.lines.find((bl) => bl.id === line.purchaseBillLineId);
          billed = billLine?.billedQty ?? new Decimal(0);
          // Σ received over ALREADY-POSTED GRNs (this one is still DRAFT, so it is not in the sum).
          receivedBefore = await this.grns.receivedSoFar(line.purchaseBillLineId, actor.companyId);
        }
        const status = matchStatusOf(billed, receivedBefore.plus(line.receivedQty));
        grn.recordMatchStatus(line.lineNo, status);
        statuses.push({ lineNo: line.lineNo, matchStatus: status });
      }

      grn.markPosted(actor.userId, this.clock.now());
      await this.grns.save(grn, grn.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'Grn',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id, status: 'POSTED' as const, lines: statuses };
    });
  }
}
