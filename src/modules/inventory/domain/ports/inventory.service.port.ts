/**
 * InventoryService port (brief 3 — the seam PUR/REQ call inside their own post transactions, FR-INV-006).
 * PURE interface: no NestJS/TypeORM. `receiveIn`/`issueOut` are a thin wrapper over brief-1's `valuation`
 * (`applyReceipt`/`valueIssue`) + `StockMovementRepository` (the locked re-roll) — the SAME mechanics the
 * Stock Journal voucher (brief 2) uses, so inventory valuation has exactly one definition regardless of
 * which voucher moved the stock (FR-INV-002, -003, -006). Neither method opens a transaction of its own;
 * the caller (PUR/REQ) must already have an active UnitOfWork when it calls these, so the movement, the
 * caller's consumption/receipt journal entry, and the caller's own voucher save commit together or not at
 * all (FR-INV-018, FR-LED-016/-017).
 *
 * `reverseIssueOut` (brief #23 — requisition-issue-posting) extends the SAME port (not a parallel one):
 * REQ's issue reversal needs INV to write a mirror IN movement restoring the godown balance by the EXACT
 * stored qty/value the original `issueOut` recorded (no re-valuation) — mirrors
 * `ReverseStockJournalUseCase`'s OUT-mirror branch exactly (`applyTransferIn` + `StockMovement.create({...,
 * direction:'IN', isReversal:true})` + `movements.append`). INV still owns the port and the valuation
 * logic; REQ only calls it, matching the "one valuation definition" rule (FR-INV-006, FR-INV-020).
 */
import Decimal from 'decimal.js';

/** The caller-supplied posting context — INV assumes no company/voucher identity of its own. */
export interface PostCtx {
  companyId: string;
  voucherDate: string;
  postedBy: string;
}

export interface ReceiveInInput {
  godownId: string;
  itemId: string;
  qty: Decimal;
  rate: Decimal;
  /** The originating GRN id — traceability (`stock_movement.source_id`, `source_type='GRN'`). */
  sourceId: string;
}

export interface IssueOutInput {
  godownId: string;
  itemId: string;
  qty: Decimal;
  allowNegative: boolean;
  /** The originating requisition-issue id — traceability (`source_type='REQ_ISSUE'`). */
  sourceId: string;
}

export interface ReverseIssueOutInput {
  godownId: string;
  itemId: string;
  /** The EXACT qty the original `issueOut` moved — restored verbatim, never re-derived. */
  qty: Decimal;
  /** The EXACT value the original `issueOut` recorded — restored verbatim, no re-valuation. */
  value: Decimal;
  /** The reversing RequisitionIssue(Line) id — traceability (`source_type='REQ_ISSUE'`, `isReversal=true`). */
  sourceId: string;
}

export interface InventoryService {
  /**
   * Receipt-in (PUR goods-receipt): rolls the godown's weighted average via `applyReceipt` and appends a
   * `direction='IN', sourceType='GRN'` movement. Returns the new average (`null` only if qty ends at 0,
   * which a receipt never does). No StockJournal voucher is created (FR-INV-006, -002).
   */
  receiveIn(ctx: PostCtx, input: ReceiveInInput): Promise<{ avgRate: Decimal | null }>;

  /**
   * Issue-out (REQ requisition issue): values the issue at the current source average via `valueIssue`
   * (negative-stock guard, FR-INV-014/-015) and appends a `direction='OUT', sourceType='REQ_ISSUE'`
   * movement. Returns `{issuedValue, rate, movementId}` so the caller can build its own balanced,
   * four-dimension-tagged consumption `PostingCommand` (Dr material expense / Cr inventory) and post it via
   * LED's `PostingService` — `issueOut` itself writes NO journal line (FR-INV-003, -016; one posting
   * layer). `movementId` is the written `stock_movement.id` (brief #23 — requisition-issue-posting — needs
   * it to store a real FK on `requisition_issue_line.stock_movement_id`, not just the caller's `sourceId`).
   */
  issueOut(
    ctx: PostCtx,
    input: IssueOutInput,
  ): Promise<{ issuedValue: Decimal; rate: Decimal; movementId: string }>;

  /**
   * Reverse a prior `issueOut` (REQ issue correction): writes an `IN`, `isReversal=true` mirror movement
   * that restores the godown balance by the EXACT stored qty/value — never a re-valued amount (design
   * §5.3). Uses `applyTransferIn` (the same value-neutral restore `ReverseStockJournalUseCase` uses for
   * its OUT-mirror branch), under the same `(godown,item)` lock. The caller (REQ) already holds the
   * original qty/rate/value on its own `RequisitionIssueLine`, so this needs no re-query of INV.
   */
  reverseIssueOut(ctx: PostCtx, input: ReverseIssueOutInput): Promise<void>;
}

export const INVENTORY_SERVICE = Symbol('InventoryService');
