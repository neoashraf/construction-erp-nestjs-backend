/**
 * StockJournal aggregate + StockJournalLine (PURE — no NestJS/TypeORM). The single inventory voucher
 * (SRS §4, design §2.1): `DRAFT → APPROVED → POSTED → CANCELLED`. Enforces STRUCTURE + LIFECYCLE only —
 * mode/side rules (TRANSFER needs both godowns & to≠from; ISSUE needs from only, rejects a to; ADJUSTMENT
 * single-sided; quantity>0 — FR-INV-008, edge 2) and the status transitions. It does NOT know on-hand
 * balances, period state, project status, the tag matrix, or numbering — those are application-orchestrated
 * policy via ports (design §2.1), keeping the domain pure. Modeled on
 * `modules/contra-journal/domain/journal-voucher.ts`'s props pattern (rehydrate, get props()/get version()).
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import {
  IssueSideOnTransferOnlyError,
  InvalidStockJournalTransitionError,
  NotApprovedError,
  SameGodownTransferError,
  StockJournalAlreadyReversedError,
  StockJournalPostedImmutableError,
} from './errors';
import { STOCK_JOURNAL_MODES, StockJournalMode, sideRuleFor } from './stock-journal-mode';

export const STOCK_JOURNAL_STATUSES = ['DRAFT', 'APPROVED', 'POSTED', 'CANCELLED'] as const;
export type StockJournalStatus = (typeof STOCK_JOURNAL_STATUSES)[number];

export type StockJournalSide = 'OUT' | 'IN';

export interface NewStockJournalLine {
  side: StockJournalSide;
  godownId: string;
  itemId: string;
  quantity: Decimal | string | number;
  projectId: string;
  costCentreId: string;
  purposeId: string;
}

export interface StockJournalLineProps {
  lineNo: number;
  side: StockJournalSide;
  godownId: string;
  itemId: string;
  quantity: Decimal;
  /** Set only after post (weighted-average source rate for OUT; carried value for IN). */
  rate: Decimal | null;
  value: Decimal | null;
  projectId: string;
  costCentreId: string;
  purposeId: string;
}

export class StockJournalLine {
  private constructor(readonly props: StockJournalLineProps) {}

  static create(input: NewStockJournalLine, lineNo: number): StockJournalLine {
    const quantity = toQty(input.quantity);
    if (!quantity.greaterThan(0)) {
      throw new ValidationError('quantity must be > 0', { lineNo, quantity: quantity.toString() });
    }
    return new StockJournalLine({
      lineNo,
      side: input.side,
      godownId: req(input.godownId, 'godownId'),
      itemId: req(input.itemId, 'itemId'),
      quantity,
      rate: null,
      value: null,
      projectId: req(input.projectId, 'projectId'),
      costCentreId: req(input.costCentreId, 'costCentreId'),
      purposeId: req(input.purposeId, 'purposeId'),
    });
  }

  static rehydrate(props: StockJournalLineProps): StockJournalLine {
    return new StockJournalLine(props);
  }

  /** Return a copy of this line with its post-time rate/value recorded (called by the post use case). */
  withValuation(rate: Decimal, value: Decimal): StockJournalLine {
    return new StockJournalLine({ ...this.props, rate, value });
  }
}

export interface NewStockJournal {
  voucherDate: string; // 'YYYY-MM-DD'
  mode: StockJournalMode;
  fromGodownId?: string | null;
  toGodownId?: string | null;
  itemId: string;
  quantity: Decimal | string | number;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  issuedById?: string | null;
  receivedById?: string | null;
  narration?: string | null;
}

export interface StockJournalProps {
  companyId: string;
  financialYearId: string;
  entryNo: string | null;
  voucherDate: string;
  mode: StockJournalMode;
  status: StockJournalStatus;
  fromGodownId: string | null;
  toGodownId: string | null;
  itemId: string;
  quantity: Decimal;
  rate: Decimal | null;
  value: Decimal | null;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  issuedById: string | null;
  receivedById: string | null;
  approvedById: string | null;
  approvedAt: Date | null;
  allowNegativeStock: boolean;
  negativeStockAuthorisedById: string | null;
  negativeStockReason: string | null;
  journalEntryId: string | null;
  narration: string | null;
  postedAt: Date | null;
  postedById: string | null;
  version: number;
  lines: StockJournalLine[];
}

export class StockJournal extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: StockJournalProps,
  ) {
    super(id);
  }

  /**
   * Build a DRAFT. Enforces per-mode side presence (TRANSFER needs both godowns & to≠from; ISSUE needs
   * from only and rejects a to; ADJUSTMENT single-sided) and qty>0 (FR-INV-008, edge 2). Also builds the
   * OUT/IN `StockJournalLine`s (design §2.1 `toLines()`), each carrying the four dimensions per the
   * matrix (FR-INV-009) — for a single-item journal both sides share the header's project/cost_centre/
   * purpose (SRS §8 note); a future multi-item journal would pass distinct `lines` per side.
   */
  static createDraft(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewStockJournal,
  ): StockJournal {
    if (!STOCK_JOURNAL_MODES.includes(input.mode)) {
      throw new ValidationError(`mode must be one of ${STOCK_JOURNAL_MODES.join(', ')}`, {
        mode: input.mode,
      });
    }
    const rule = sideRuleFor(input.mode);
    const fromGodownId = clean(input.fromGodownId);
    const toGodownId = clean(input.toGodownId);

    if (rule.toForbidden && toGodownId) {
      throw new IssueSideOnTransferOnlyError(input.mode);
    }
    if (rule.fromRequired && !fromGodownId) {
      throw new ValidationError('fromGodownId is required for this mode', { mode: input.mode });
    }
    if (rule.toRequired && !toGodownId) {
      throw new ValidationError('toGodownId is required for this mode', { mode: input.mode });
    }
    if (input.mode === 'ADJUSTMENT' && !fromGodownId && !toGodownId) {
      throw new ValidationError('ADJUSTMENT requires exactly one of fromGodownId/toGodownId', {
        mode: input.mode,
      });
    }
    if (input.mode === 'TRANSFER' && fromGodownId && toGodownId && fromGodownId === toGodownId) {
      throw new SameGodownTransferError(fromGodownId);
    }

    const quantity = toQty(input.quantity);
    if (!quantity.greaterThan(0)) {
      throw new ValidationError('quantity must be > 0', { quantity: quantity.toString() });
    }

    const projectId = req(input.projectId, 'projectId');
    const costCentreId = req(input.costCentreId, 'costCentreId');
    const purposeId = req(input.purposeId, 'purposeId');
    const itemId = req(input.itemId, 'itemId');

    const lines: StockJournalLine[] = [];
    let lineNo = 1;
    if (fromGodownId) {
      lines.push(
        StockJournalLine.create(
          { side: 'OUT', godownId: fromGodownId, itemId, quantity, projectId, costCentreId, purposeId },
          lineNo++,
        ),
      );
    }
    if (toGodownId) {
      lines.push(
        StockJournalLine.create(
          { side: 'IN', godownId: toGodownId, itemId, quantity, projectId, costCentreId, purposeId },
          lineNo++,
        ),
      );
    }

    return new StockJournal(id, {
      companyId,
      financialYearId,
      entryNo: null,
      voucherDate: req(input.voucherDate, 'voucherDate'),
      mode: input.mode,
      status: 'DRAFT',
      fromGodownId,
      toGodownId,
      itemId,
      quantity,
      rate: null,
      value: null,
      projectId,
      costCentreId,
      purposeId,
      issuedById: clean(input.issuedById),
      receivedById: clean(input.receivedById),
      approvedById: null,
      approvedAt: null,
      allowNegativeStock: false,
      negativeStockAuthorisedById: null,
      negativeStockReason: null,
      journalEntryId: null,
      narration: input.narration ?? null,
      postedAt: null,
      postedById: null,
      version: 1,
      lines,
    });
  }

  static rehydrate(id: string, props: StockJournalProps): StockJournal {
    return new StockJournal(id, props);
  }

  /** Replace the draft's content. Only while DRAFT (FR-INV-022). */
  editDraft(patch: Partial<NewStockJournal>): void {
    this.assertStatus('DRAFT');
    const merged: NewStockJournal = {
      voucherDate: patch.voucherDate ?? this._props.voucherDate,
      mode: patch.mode ?? this._props.mode,
      fromGodownId: patch.fromGodownId !== undefined ? patch.fromGodownId : this._props.fromGodownId,
      toGodownId: patch.toGodownId !== undefined ? patch.toGodownId : this._props.toGodownId,
      itemId: patch.itemId ?? this._props.itemId,
      quantity: patch.quantity ?? this._props.quantity,
      projectId: patch.projectId ?? this._props.projectId,
      costCentreId: patch.costCentreId ?? this._props.costCentreId,
      purposeId: patch.purposeId ?? this._props.purposeId,
      issuedById: patch.issuedById !== undefined ? patch.issuedById : this._props.issuedById,
      receivedById: patch.receivedById !== undefined ? patch.receivedById : this._props.receivedById,
      narration: patch.narration !== undefined ? patch.narration : this._props.narration,
    };
    const rebuilt = StockJournal.createDraft(this.id, this._props.companyId, this._props.financialYearId, merged);
    this._props = { ...this._props, ...rebuilt.props, version: this._props.version };
  }

  /** DRAFT → APPROVED; sets approvedById/approvedAt (FR-INV-012/-013). */
  approve(approverId: string, now: Date): void {
    if (this._props.status !== 'DRAFT') {
      throw new InvalidStockJournalTransitionError(this._props.status, 'approve');
    }
    this._props.status = 'APPROVED';
    this._props.approvedById = approverId;
    this._props.approvedAt = now;
  }

  /** Throws `NotApprovedError` unless status === APPROVED (edge 3). */
  assertPostable(): void {
    if (this._props.status !== 'APPROVED') {
      throw new NotApprovedError(this._props.status);
    }
  }

  /** Only a POSTED journal can be reversed. */
  assertPosted(): void {
    if (this._props.status === 'CANCELLED') {
      throw new StockJournalAlreadyReversedError(this.id);
    }
    if (this._props.status !== 'POSTED') {
      throw new InvalidStockJournalTransitionError(this._props.status, 'reverse');
    }
  }

  /**
   * Record the negative-stock authorisation on the voucher (FR-INV-015), before posting. Call before
   * `markPosted`; a `negativeStockReason` is required whenever `allowNegativeStock` is true — validated
   * by the use case/DTO layer per architectural decision 6.
   */
  recordNegativeStockAuthorisation(authorisedById: string | null, reason: string | null): void {
    this._props.allowNegativeStock = authorisedById != null;
    this._props.negativeStockAuthorisedById = authorisedById;
    this._props.negativeStockReason = reason;
  }

  /** → POSTED. `entryNo`/`journalEntryId` stay null for a value-neutral same-account transfer (§4.2). */
  markPosted(
    entryNo: string | null,
    journalEntryId: string | null,
    rate: Decimal,
    value: Decimal,
    lines: StockJournalLine[],
    postedById: string,
    now: Date,
  ): void {
    this.assertPostable();
    this._props.status = 'POSTED';
    this._props.entryNo = entryNo;
    this._props.journalEntryId = journalEntryId;
    this._props.rate = rate;
    this._props.value = value;
    this._props.lines = lines;
    this._props.postedById = postedById;
    this._props.postedAt = now;
  }

  /** POSTED → CANCELLED (set by the reverse use case). */
  markCancelled(): void {
    this.assertPosted();
    this._props.status = 'CANCELLED';
  }

  /** Whether an edit/delete is allowed right now (DRAFT only). */
  assertEditable(): void {
    if (this._props.status !== 'DRAFT') {
      throw new StockJournalPostedImmutableError(this._props.status);
    }
  }

  /** The OUT/IN sides this voucher affects (design §2.1 `toLines()`). */
  toLines(): StockJournalLine[] {
    return this._props.lines;
  }

  private assertStatus(status: StockJournalStatus): void {
    if (this._props.status !== status) {
      throw new InvalidStockJournalTransitionError(this._props.status, `edit (requires ${status})`);
    }
  }

  get props(): Readonly<StockJournalProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}

function clean(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

function toQty(value: Decimal | string | number): Decimal {
  let d: Decimal;
  try {
    d = value instanceof Decimal ? value : new Decimal(value);
  } catch {
    throw new ValidationError('quantity is not a valid number', { value: String(value) });
  }
  if (!d.isFinite()) throw new ValidationError('quantity must be a finite number', { value: String(value) });
  return d;
}
