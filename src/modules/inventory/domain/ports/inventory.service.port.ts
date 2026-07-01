/**
 * InventoryService port (brief 3 — the seam PUR/REQ call inside their own post transactions, FR-INV-006).
 * PURE interface: no NestJS/TypeORM. `receiveIn`/`issueOut` are a thin wrapper over brief-1's `valuation`
 * (`applyReceipt`/`valueIssue`) + `StockMovementRepository` (the locked re-roll) — the SAME mechanics the
 * Stock Journal voucher (brief 2) uses, so inventory valuation has exactly one definition regardless of
 * which voucher moved the stock (FR-INV-002, -003, -006). Neither method opens a transaction of its own;
 * the caller (PUR/REQ) must already have an active UnitOfWork when it calls these, so the movement, the
 * caller's consumption/receipt journal entry, and the caller's own voucher save commit together or not at
 * all (FR-INV-018, FR-LED-016/-017).
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
   * movement. Returns `{issuedValue, rate}` so the caller can build its own balanced, four-dimension-
   * tagged consumption `PostingCommand` (Dr material expense / Cr inventory) and post it via LED's
   * `PostingService` — `issueOut` itself writes NO journal line (FR-INV-003, -016; one posting layer).
   */
  issueOut(ctx: PostCtx, input: IssueOutInput): Promise<{ issuedValue: Decimal; rate: Decimal }>;
}

export const INVENTORY_SERVICE = Symbol('InventoryService');
