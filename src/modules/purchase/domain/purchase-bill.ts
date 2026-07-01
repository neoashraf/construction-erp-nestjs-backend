/**
 * PurchaseBill aggregate root (PURE — no NestJS/TypeORM). The supplier-invoice posting voucher in a
 * draft->posted->cancelled lifecycle (design §2.1). OWNS the line/tax money math and the lifecycle:
 *   - lineAmount = billedQty x rate (exact Decimal) per line;
 *   - vatInput/tds/ait per line = rate x base (overridable), summed to header totals;
 *   - grossAmount = Σ lineAmount;
 *   - netPayableAmount (residual, the AP credit) = gross + vatInput - tds - ait (>= 0, FR-PUR-007).
 * Each line is stock XOR expense (FR-PUR-005): a stock line carries itemId+godownId (isStockLine=true,
 * rolls inventory via INV); a non-stock line carries expenseAccountId (isStockLine=false, no inventory
 * roll). It does NOT know about the tag matrix, numbering, period state, or how the ledger/inventory are
 * written — those are LED's/INV's, reached via the use case (bill-posting.ts builds the command).
 * `netPayableAmount` is recomputed on every draft edit and is the single source of the AP amount, so the
 * posting command always balances by construction (mirrors SAL's `Ipc` exactly).
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import { LineTypeError, NetPayableNegativeError, NotDraftError, NotPostedError } from './errors';
import { PurchaseTax } from './tax';

export const PURCHASE_BILL_SOURCE_TYPE = 'PurchaseBill';

export type PurchaseBillStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';
export const PURCHASE_BILL_STATUSES: readonly PurchaseBillStatus[] = ['DRAFT', 'POSTED', 'CANCELLED'] as const;

const MONEY_SCALE = 4;

/** One bill line as supplied by the caller. Stock XOR non-stock — never both, never neither. */
export interface NewPurchaseBillLine {
  itemId?: string | null;
  expenseAccountId?: string | null;
  isStockLine: boolean;
  billedQty: Decimal | string | number;
  rate: Decimal | string | number;
  godownId?: string | null;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  /** Optional overrides; when omitted the rate-derived defaults (PurchaseTax x lineAmount) are used. */
  vatInputAmount?: Decimal | string | number | null;
  tdsAmount?: Decimal | string | number | null;
  aitAmount?: Decimal | string | number | null;
}

export interface PurchaseBillLineProps {
  id: string;
  lineNo: number;
  itemId: string | null;
  expenseAccountId: string | null;
  isStockLine: boolean;
  billedQty: Decimal;
  rate: Decimal;
  lineAmount: Decimal;
  vatInputAmount: Decimal;
  tdsAmount: Decimal;
  aitAmount: Decimal;
  godownId: string | null;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  receivedQty: Decimal;
}

export interface NewPurchaseBill {
  projectId: string;
  supplierId: string;
  purchaseOrderId?: string | null;
  supplierInvoiceRef?: string | null;
  billDate: string; // 'YYYY-MM-DD'
  dueDate: string;
  narration?: string | null;
  lines: NewPurchaseBillLine[];
}

export type EditPurchaseBill = Partial<Omit<NewPurchaseBill, 'lines'>> & { lines?: NewPurchaseBillLine[] };

export interface PurchaseBillProps {
  companyId: string;
  financialYearId: string;
  projectId: string;
  supplierId: string;
  purchaseOrderId: string | null;
  supplierInvoiceRef: string | null;
  billDate: string;
  dueDate: string;
  grossAmount: Money;
  vatInputAmount: Money;
  tdsAmount: Money;
  aitAmount: Money;
  netPayableAmount: Money; // residual — derived, the AP credit
  narration: string | null;
  status: PurchaseBillStatus;
  entryNo: string | null;
  journalEntryId: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  version: number;
}

export class PurchaseBill extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: PurchaseBillProps,
    private _lines: PurchaseBillLineProps[],
  ) {
    super(id);
  }

  static createDraft(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewPurchaseBill,
    tax: PurchaseTax,
    lineIds: string[],
  ): PurchaseBill {
    const { lines, figures } = buildLines(input.lines, tax, lineIds);
    return new PurchaseBill(
      id,
      {
        companyId,
        financialYearId,
        projectId: req(input.projectId, 'projectId'),
        supplierId: req(input.supplierId, 'supplierId'),
        purchaseOrderId: input.purchaseOrderId ?? null,
        supplierInvoiceRef: input.supplierInvoiceRef ?? null,
        billDate: req(input.billDate, 'billDate'),
        dueDate: reqDueDate(input.billDate, input.dueDate),
        grossAmount: figures.gross,
        vatInputAmount: figures.vatInput,
        tdsAmount: figures.tds,
        aitAmount: figures.ait,
        netPayableAmount: figures.netPayable,
        narration: input.narration ?? null,
        status: 'DRAFT',
        entryNo: null,
        journalEntryId: null,
        postedAt: null,
        postedBy: null,
        version: 1,
      },
      lines,
    );
  }

  static rehydrate(id: string, props: PurchaseBillProps, lines: PurchaseBillLineProps[]): PurchaseBill {
    return new PurchaseBill(id, props, lines);
  }

  /** Edit the draft in place (only while DRAFT — FR-PUR-024). Recomputes all figures on the new values. */
  updateDraft(patch: EditPurchaseBill, tax: PurchaseTax, lineIds: string[]): void {
    this.assertDraft();
    const p = this._props;
    p.projectId = patch.projectId !== undefined ? req(patch.projectId, 'projectId') : p.projectId;
    p.supplierId = patch.supplierId !== undefined ? req(patch.supplierId, 'supplierId') : p.supplierId;
    p.purchaseOrderId = patch.purchaseOrderId !== undefined ? patch.purchaseOrderId ?? null : p.purchaseOrderId;
    p.supplierInvoiceRef =
      patch.supplierInvoiceRef !== undefined ? patch.supplierInvoiceRef ?? null : p.supplierInvoiceRef;
    const billDate = patch.billDate !== undefined ? req(patch.billDate, 'billDate') : p.billDate;
    p.billDate = billDate;
    p.dueDate = patch.dueDate !== undefined ? reqDueDate(billDate, patch.dueDate) : p.dueDate;
    p.narration = patch.narration !== undefined ? patch.narration : p.narration;

    if (patch.lines !== undefined) {
      const { lines, figures } = buildLines(patch.lines, tax, lineIds);
      this._lines = lines;
      p.grossAmount = figures.gross;
      p.vatInputAmount = figures.vatInput;
      p.tdsAmount = figures.tds;
      p.aitAmount = figures.ait;
      p.netPayableAmount = figures.netPayable;
    }
  }

  assertPostable(): void {
    this.assertDraft();
    if (!this._lines.length) {
      throw new ValidationError('A Purchase Bill requires at least one line to post', {});
    }
  }

  markPosted(entryId: string, entryNo: string, by: string, at: Date): void {
    this.assertDraft();
    this._props.status = 'POSTED';
    this._props.journalEntryId = entryId;
    this._props.entryNo = entryNo;
    this._props.postedBy = by;
    this._props.postedAt = at;
  }

  markCancelled(): void {
    if (this._props.status !== 'POSTED') throw new NotPostedError(this._props.status);
    this._props.status = 'CANCELLED';
  }

  assertPosted(): void {
    if (this._props.status !== 'POSTED') throw new NotPostedError(this._props.status);
  }

  /** Cost lines for CC's prospective budget check (project, cost_centre, amount) — every line, stock or not. */
  costLines(): { projectId: string; costCentreId: string; amount: Decimal }[] {
    return this._lines.map((l) => ({
      projectId: l.projectId,
      costCentreId: l.costCentreId,
      amount: l.lineAmount,
    }));
  }

  /** Stock lines only — handed to INV `receiveIn` per line (FR-PUR-011). */
  stockLines(): readonly PurchaseBillLineProps[] {
    return this._lines.filter((l) => l.isStockLine);
  }

  private assertDraft(): void {
    if (this._props.status !== 'DRAFT') throw new NotDraftError(this._props.status);
  }

  get props(): Readonly<PurchaseBillProps> {
    return this._props;
  }
  get lines(): readonly PurchaseBillLineProps[] {
    return this._lines;
  }
  get version(): number {
    return this._props.version;
  }
}

// ---- line + figures construction (pure math) --------------------------------------------------------

function buildLines(
  input: NewPurchaseBillLine[],
  tax: PurchaseTax,
  ids: string[],
): {
  lines: PurchaseBillLineProps[];
  figures: { gross: Money; vatInput: Money; tds: Money; ait: Money; netPayable: Money };
} {
  if (!input?.length) {
    throw new ValidationError('A Purchase Bill requires at least one line', { field: 'lines' });
  }

  let gross = new Decimal(0);
  let vatInput = new Decimal(0);
  let tds = new Decimal(0);
  let ait = new Decimal(0);

  const lines: PurchaseBillLineProps[] = input.map((l, i) => {
    const lineNo = i + 1;
    const hasItem = !!l.itemId;
    const hasExpense = !!l.expenseAccountId;
    if (hasItem === hasExpense) {
      // both or neither — invalid (FR-PUR-005, §11)
      throw new LineTypeError(lineNo);
    }
    if (l.isStockLine !== hasItem) {
      throw new LineTypeError(lineNo);
    }
    if (l.isStockLine && !l.godownId) {
      throw new ValidationError('godownId is required on a stock line', { lineNo, field: 'godownId' });
    }

    const billedQty = toDecimal(l.billedQty, 'billedQty');
    if (!billedQty.greaterThan(0)) {
      throw new ValidationError('billedQty must be > 0', { lineNo, billedQty: billedQty.toString() });
    }
    const rate = assertNonNeg(toDecimal(l.rate, 'rate'), 'rate');
    const lineAmount = round4(billedQty.times(rate));

    const vatInputLine =
      l.vatInputAmount !== undefined && l.vatInputAmount !== null
        ? assertNonNeg(round4(toDecimal(l.vatInputAmount, 'vatInputAmount')), 'vatInputAmount')
        : round4(lineAmount.times(tax.vatInputFraction()));
    const tdsLine =
      l.tdsAmount !== undefined && l.tdsAmount !== null
        ? assertNonNeg(round4(toDecimal(l.tdsAmount, 'tdsAmount')), 'tdsAmount')
        : round4(lineAmount.times(tax.tdsFraction()));
    const aitLine =
      l.aitAmount !== undefined && l.aitAmount !== null
        ? assertNonNeg(round4(toDecimal(l.aitAmount, 'aitAmount')), 'aitAmount')
        : round4(lineAmount.times(tax.aitFraction()));

    gross = gross.plus(lineAmount);
    vatInput = vatInput.plus(vatInputLine);
    tds = tds.plus(tdsLine);
    ait = ait.plus(aitLine);

    return {
      id: ids[i],
      lineNo,
      itemId: l.itemId ?? null,
      expenseAccountId: l.expenseAccountId ?? null,
      isStockLine: l.isStockLine,
      billedQty,
      rate,
      lineAmount,
      vatInputAmount: vatInputLine,
      tdsAmount: tdsLine,
      aitAmount: aitLine,
      godownId: l.isStockLine ? req(l.godownId as string, 'godownId') : null,
      projectId: req(l.projectId, 'projectId'),
      costCentreId: req(l.costCentreId, 'costCentreId'),
      purposeId: req(l.purposeId, 'purposeId'),
      receivedQty: new Decimal(0),
    };
  });

  const netPayableDec = gross.plus(vatInput).minus(tds).minus(ait);
  if (netPayableDec.isNegative()) {
    throw new NetPayableNegativeError(netPayableDec.toFixed(MONEY_SCALE));
  }

  return {
    lines,
    figures: {
      gross: Money.of(round4(gross)),
      vatInput: Money.of(round4(vatInput)),
      tds: Money.of(round4(tds)),
      ait: Money.of(round4(ait)),
      netPayable: Money.of(round4(netPayableDec)),
    },
  };
}

function round4(d: Decimal): Decimal {
  return d.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
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

function assertNonNeg(d: Decimal, field: string): Decimal {
  if (d.isNegative()) throw new ValidationError(`${field} must be >= 0`, { field });
  return d;
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}

function reqDueDate(billDate: string | undefined, dueDate: string | undefined): string {
  const bill = req(billDate ?? '', 'billDate');
  const due = req(dueDate ?? '', 'dueDate');
  if (due < bill) throw new ValidationError('dueDate must be >= billDate', { billDate: bill, dueDate: due });
  return due;
}
