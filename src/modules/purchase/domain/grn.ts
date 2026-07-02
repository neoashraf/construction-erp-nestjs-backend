/**
 * Grn aggregate root (PURE — no NestJS/TypeORM). The record that goods were PHYSICALLY received against a
 * PO and/or Bill, by item, received quantity, rate, and godown, in a DRAFT -> POSTED -> (CANCELLED)
 * lifecycle (FR-PUR-015, FR-PUR-016). `received_qty > 0` per line; each line carries the four dimensions
 * (project + cost_centre + purpose + godown — informational, mirroring the referenced bill line's dims)
 * and may reference the `purchase_bill_line` it receives against (partial receipt, FR-PUR-018).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * §10 Q4 GRN-CLEARING DECISION — RESOLVED to option (a): "received = billed at bill post".
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Per design doc 08-purchase §10 Q1/Q4's own recommendation ("ship (a) as the default"), applied under
 * the platform's assumed-defaults-pending-client convention (CLAUDE.md):
 *   - The Purchase BILL post carries the receipt — brief #25's PostPurchaseBillUseCase already calls
 *     INV `receiveIn` for the billed quantity and debits inventory in the bill entry (§4.1).
 *   - The GRN is therefore an INFORMATIONAL physical-receipt record: posting a GRN writes NO
 *     `stock_movement` (a second `receiveIn` would DOUBLE-COUNT stock already rolled by the bill), NO
 *     `journal_entry` (no GRN-clearing account exists — `grn-clearing.ts` is NOT built), and consumes NO
 *     voucher number. The stock-ledger/GL reconciliation invariant (FR-INV-005) is untouched by a GRN.
 *   - What the GRN post DOES do: snapshot each line's billed-vs-received `match_status` (match.ts,
 *     FR-PUR-017) and flip DRAFT -> POSTED; cancel is a status flip only (no reverseReceipt, no
 *     posting.reverse). Over-delivery is recorded as OVER_RECEIVED, advisory, never blocked (edge case 6).
 *   - If the client later confirms decoupled receipt (goods-in-transit), option (b) adds a MAS
 *     GRN-clearing account + a `Dr Inventory / Cr GRN-Clearing` command builder — a new brief, not this one.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `receiptLines()` still yields the `(godownId, itemId, receivedQty, rate)` shape design §2.3 names so an
 * option-(b) rebind would not reshape the aggregate — under option (a) NO caller feeds it to INV.
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { GrnNotDraftError, GrnNotPostedError } from './errors';
import { MatchStatus } from './match';

export type GrnStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';
export const GRN_STATUSES: readonly GrnStatus[] = ['DRAFT', 'POSTED', 'CANCELLED'] as const;

const MONEY_SCALE = 4;

/** One GRN line as supplied by the caller (the Store Keeper's ACTUAL received quantity, FR-PUR-016). */
export interface NewGrnLine {
  purchaseBillLineId?: string | null;
  itemId: string;
  receivedQty: Decimal | string | number;
  rate: Decimal | string | number;
  godownId: string;
  /** Defaults to the GRN header's project when omitted. */
  projectId?: string | null;
  costCentreId: string;
  purposeId: string;
}

export interface GrnLineProps {
  id: string;
  lineNo: number;
  purchaseBillLineId: string | null;
  itemId: string;
  receivedQty: Decimal;
  rate: Decimal;
  receivedValue: Decimal; // receivedQty × rate — informational under option (a); NOT posted anywhere
  godownId: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  /** Snapshotted at post from match.ts (billed-vs-received at that moment); null while DRAFT. */
  matchStatus: MatchStatus | null;
}

export interface NewGrn {
  projectId: string;
  supplierId: string;
  purchaseOrderId?: string | null;
  purchaseBillId?: string | null;
  grnRefNo?: string | null;
  receiptDate: string; // 'YYYY-MM-DD'
  narration?: string | null;
  lines: NewGrnLine[];
}

export type EditGrn = Partial<Omit<NewGrn, 'lines'>> & { lines?: NewGrnLine[] };

export interface GrnProps {
  companyId: string;
  financialYearId: string;
  projectId: string;
  supplierId: string;
  purchaseOrderId: string | null;
  purchaseBillId: string | null;
  grnRefNo: string | null;
  receiptDate: string;
  status: GrnStatus;
  receivedBy: string | null;
  narration: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  version: number;
}

/** The `(godownId, itemId, receivedQty, rate)` receipt shape (design §2.3). Informational under option (a). */
export interface ReceiptIn {
  godownId: string;
  itemId: string;
  receivedQty: Decimal;
  rate: Decimal;
  receivedValue: Decimal;
}

export class Grn extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: GrnProps,
    private _lines: GrnLineProps[],
  ) {
    super(id);
  }

  /** FR-PUR-015 — received_qty > 0 per line, godown + the four dimensions; against a PO and/or Bill. */
  static createDraft(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewGrn,
    lineIds: string[],
  ): Grn {
    const projectId = req(input.projectId, 'projectId');
    return new Grn(
      id,
      {
        companyId,
        financialYearId,
        projectId,
        supplierId: req(input.supplierId, 'supplierId'),
        purchaseOrderId: input.purchaseOrderId ?? null,
        purchaseBillId: input.purchaseBillId ?? null,
        grnRefNo: input.grnRefNo ?? null,
        receiptDate: req(input.receiptDate, 'receiptDate'),
        status: 'DRAFT',
        receivedBy: null,
        narration: input.narration ?? null,
        postedAt: null,
        postedBy: null,
        version: 1,
      },
      buildLines(input.lines, projectId, lineIds),
    );
  }

  static rehydrate(id: string, props: GrnProps, lines: GrnLineProps[]): Grn {
    return new Grn(id, props, lines);
  }

  /** Edit in place only while DRAFT (FR-PUR-024). Lines, if supplied, replace the set wholesale. */
  updateDraft(patch: EditGrn, lineIds: string[]): void {
    this.assertDraft();
    const p = this._props;
    p.projectId = patch.projectId !== undefined ? req(patch.projectId, 'projectId') : p.projectId;
    p.supplierId = patch.supplierId !== undefined ? req(patch.supplierId, 'supplierId') : p.supplierId;
    p.purchaseOrderId = patch.purchaseOrderId !== undefined ? patch.purchaseOrderId ?? null : p.purchaseOrderId;
    p.purchaseBillId = patch.purchaseBillId !== undefined ? patch.purchaseBillId ?? null : p.purchaseBillId;
    p.grnRefNo = patch.grnRefNo !== undefined ? patch.grnRefNo ?? null : p.grnRefNo;
    p.receiptDate = patch.receiptDate !== undefined ? req(patch.receiptDate, 'receiptDate') : p.receiptDate;
    p.narration = patch.narration !== undefined ? patch.narration ?? null : p.narration;
    if (patch.lines !== undefined) {
      this._lines = buildLines(patch.lines, p.projectId, lineIds);
    }
  }

  assertPostable(): void {
    this.assertDraft();
    if (!this._lines.length) {
      throw new ValidationError('A GRN requires at least one line to post', {});
    }
  }

  /**
   * DRAFT -> POSTED. Under option (a) this is the ONLY effect of a GRN post besides the match-status
   * snapshot: no inventory movement, no ledger entry, no number (see the class doc).
   */
  markPosted(by: string, at: Date): void {
    this.assertDraft();
    this._props.status = 'POSTED';
    this._props.postedBy = by;
    this._props.receivedBy = this._props.receivedBy ?? by;
    this._props.postedAt = at;
  }

  /** POSTED -> CANCELLED — a status flip only under option (a); nothing to reverse (class doc). */
  markCancelled(): void {
    if (this._props.status !== 'POSTED') throw new GrnNotPostedError(this._props.status);
    this._props.status = 'CANCELLED';
  }

  assertPosted(): void {
    if (this._props.status !== 'POSTED') throw new GrnNotPostedError(this._props.status);
  }

  /** Snapshot a line's billed-vs-received match status (match.ts) — called by PostGrnUseCase at post. */
  recordMatchStatus(lineNo: number, status: MatchStatus): void {
    const line = this._lines.find((l) => l.lineNo === lineNo);
    if (!line) throw new ValidationError(`GRN line ${lineNo} not found`, { lineNo });
    line.matchStatus = status;
  }

  /** The design §2.3 receipt shape. Under option (a) NO caller hands this to INV (class doc). */
  receiptLines(): ReceiptIn[] {
    return this._lines.map((l) => ({
      godownId: l.godownId,
      itemId: l.itemId,
      receivedQty: l.receivedQty,
      rate: l.rate,
      receivedValue: l.receivedValue,
    }));
  }

  private assertDraft(): void {
    if (this._props.status !== 'DRAFT') throw new GrnNotDraftError(this._props.status);
  }

  get props(): Readonly<GrnProps> {
    return this._props;
  }
  get lines(): readonly GrnLineProps[] {
    return this._lines;
  }
  get version(): number {
    return this._props.version;
  }
}

// ---- line construction (pure) ------------------------------------------------------------------------

function buildLines(input: NewGrnLine[], headerProjectId: string, ids: string[]): GrnLineProps[] {
  if (!input?.length) {
    throw new ValidationError('A GRN requires at least one line', { field: 'lines' });
  }
  return input.map((l, i) => {
    const lineNo = i + 1;
    const receivedQty = toDecimal(l.receivedQty, 'receivedQty');
    if (!receivedQty.greaterThan(0)) {
      // FR-PUR-015/-016 — received_qty > 0 (a zero/negative receipt is not a receipt).
      throw new ValidationError('receivedQty must be > 0', { lineNo, receivedQty: receivedQty.toString() });
    }
    const rate = toDecimal(l.rate, 'rate');
    if (rate.isNegative()) throw new ValidationError('rate must be >= 0', { lineNo, field: 'rate' });
    return {
      id: ids[i],
      lineNo,
      purchaseBillLineId: l.purchaseBillLineId ?? null,
      itemId: req(l.itemId, 'itemId'),
      receivedQty,
      rate,
      receivedValue: receivedQty.times(rate).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP),
      godownId: req(l.godownId, 'godownId'),
      projectId: l.projectId ? req(l.projectId, 'projectId') : headerProjectId,
      costCentreId: req(l.costCentreId, 'costCentreId'),
      purposeId: req(l.purposeId, 'purposeId'),
      matchStatus: null,
    };
  });
}

function toDecimal(value: Decimal | string | number | null | undefined, field: string): Decimal {
  if (value === null || value === undefined || value === '') {
    throw new ValidationError(`${field} is required`, { field });
  }
  let d: Decimal;
  try {
    d = value instanceof Decimal ? value : new Decimal(value);
  } catch {
    throw new ValidationError(`${field} is not a valid number`, { field, value: String(value) });
  }
  if (!d.isFinite()) throw new ValidationError(`${field} must be a finite number`, { field });
  return d;
}

function req(v: string | null | undefined, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}
