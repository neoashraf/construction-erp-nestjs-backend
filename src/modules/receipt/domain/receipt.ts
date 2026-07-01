/**
 * Receipt aggregate root (PURE — no NestJS/TypeORM). The customer-collection voucher (ReceiptVoucher) in a
 * draft->posted->cancelled lifecycle. It OWNS the money composition + the lifecycle:
 *   - amountSettled = cashReceived + taxDeductedAtSource (all >= 0, settled > 0) — FR-REC-019/-020;
 *   - the reference XOR: exactly one of ipcId / generalTargetAccountId, matching receiptType — FR-REC-001;
 *   - the cheque-ref rule: non-cash modes require chequeTxnRef — FR-REC-004.
 * It does NOT know about the period, the tag matrix, numbering, the IPC's outstanding, or how the ledger is
 * written — those are LED's/SAL's, reached via the use case. `amountSettled` is the single source of the
 * AR/credit amount, so the posting command always balances by construction (design §2.1). Line-to-account
 * mapping lives in receipt-posting.ts; this file computes the figures + lifecycle only.
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { Money, MONEY_SCALE } from '../../../common/money';
import { ValidationError } from '../../../common/errors/domain-error';
import { PaymentMode, requiresChequeRef } from './payment-mode';
import type { ReceiptType } from './payment-mode';
export type { ReceiptType } from './payment-mode';
import {
  ChequeRefMissingError,
  NotDraftError,
  NotPostedError,
  OverApplicationError,
  ReferenceXorError,
  SettledAmountInvalidError,
} from './errors';

export const RECEIPT_SOURCE_TYPE = 'Receipt';

export type ReceiptStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';
export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['DRAFT', 'POSTED', 'CANCELLED'] as const;

/** Fields the caller supplies to build/edit a draft. Money-ish values accept string/number/Decimal. */
export interface NewReceipt {
  receiptType: ReceiptType;
  receiptDate: string; // 'YYYY-MM-DD'
  paymentMode: PaymentMode;
  depositAccountId: string;
  partyId: string;
  projectId: string | null;
  costCentreId: string;
  purposeId: string | null;
  ipcId: string | null;
  generalTargetAccountId: string | null;
  amountSettled: Decimal | string | number;
  taxDeductedAtSource?: Decimal | string | number | null;
  chequeTxnRef?: string | null;
  narration?: string | null;
}

/** A PATCH: any of NewReceipt's fields; omitted fields keep the draft's current value. */
export type EditReceipt = Partial<NewReceipt>;

export interface ReceiptProps {
  companyId: string;
  financialYearId: string;
  receiptType: ReceiptType;
  receiptDate: string;
  paymentMode: PaymentMode;
  depositAccountId: string;
  partyId: string;
  projectId: string | null;
  costCentreId: string;
  purposeId: string | null;
  ipcId: string | null;
  generalTargetAccountId: string | null;
  amountSettled: Money;
  cashReceived: Money;
  taxDeductedAtSource: Money;
  chequeTxnRef: string | null;
  narration: string | null;
  status: ReceiptStatus;
  entryNo: string | null;
  journalEntryId: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  version: number;
}

export class Receipt extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: ReceiptProps,
  ) {
    super(id);
  }

  /** Build a DRAFT receipt. Derives cashReceived and validates the mode/ref rule + the reference XOR. */
  static createDraft(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewReceipt,
  ): Receipt {
    const figures = Receipt.computeFigures(input);
    Receipt.assertReferenceXorStatic(input.receiptType, input.ipcId ?? null, input.generalTargetAccountId ?? null);
    Receipt.assertChequeRefStatic(input.paymentMode, input.chequeTxnRef ?? null);

    return new Receipt(id, {
      companyId,
      financialYearId,
      receiptType: input.receiptType,
      receiptDate: req(input.receiptDate, 'receiptDate'),
      paymentMode: input.paymentMode,
      depositAccountId: req(input.depositAccountId, 'depositAccountId'),
      partyId: req(input.partyId, 'partyId'),
      projectId: input.projectId ?? null,
      costCentreId: req(input.costCentreId, 'costCentreId'),
      purposeId: input.purposeId ?? null,
      ipcId: input.ipcId ?? null,
      generalTargetAccountId: input.generalTargetAccountId ?? null,
      amountSettled: figures.amountSettled,
      cashReceived: figures.cashReceived,
      taxDeductedAtSource: figures.taxDeductedAtSource,
      chequeTxnRef: input.chequeTxnRef ?? null,
      narration: input.narration ?? null,
      status: 'DRAFT',
      entryNo: null,
      journalEntryId: null,
      postedAt: null,
      postedBy: null,
      version: 1,
    });
  }

  static rehydrate(id: string, props: ReceiptProps): Receipt {
    return new Receipt(id, props);
  }

  /** Edit the draft in place (only while DRAFT — FR-REC-024). Re-validates composition/XOR/cheque-ref. */
  updateDraft(patch: EditReceipt): void {
    this.assertDraft();
    const p = this._props;
    const merged: NewReceipt = {
      receiptType: patch.receiptType ?? p.receiptType,
      receiptDate: patch.receiptDate ?? p.receiptDate,
      paymentMode: patch.paymentMode ?? p.paymentMode,
      depositAccountId: patch.depositAccountId ?? p.depositAccountId,
      partyId: patch.partyId ?? p.partyId,
      projectId: patch.projectId !== undefined ? patch.projectId : p.projectId,
      costCentreId: patch.costCentreId ?? p.costCentreId,
      purposeId: patch.purposeId !== undefined ? patch.purposeId : p.purposeId,
      ipcId: patch.ipcId !== undefined ? patch.ipcId : p.ipcId,
      generalTargetAccountId:
        patch.generalTargetAccountId !== undefined ? patch.generalTargetAccountId : p.generalTargetAccountId,
      amountSettled: patch.amountSettled ?? p.amountSettled.amount,
      taxDeductedAtSource:
        patch.taxDeductedAtSource !== undefined ? patch.taxDeductedAtSource : p.taxDeductedAtSource.amount,
      chequeTxnRef: patch.chequeTxnRef !== undefined ? patch.chequeTxnRef : p.chequeTxnRef,
      narration: patch.narration !== undefined ? patch.narration : p.narration,
    };
    const figures = Receipt.computeFigures(merged);
    Receipt.assertReferenceXorStatic(merged.receiptType, merged.ipcId, merged.generalTargetAccountId);
    Receipt.assertChequeRefStatic(merged.paymentMode, merged.chequeTxnRef ?? null);

    p.receiptType = merged.receiptType;
    p.receiptDate = req(merged.receiptDate, 'receiptDate');
    p.paymentMode = merged.paymentMode;
    p.depositAccountId = req(merged.depositAccountId, 'depositAccountId');
    p.partyId = req(merged.partyId, 'partyId');
    p.projectId = merged.projectId;
    p.costCentreId = req(merged.costCentreId, 'costCentreId');
    p.purposeId = merged.purposeId;
    p.ipcId = merged.ipcId;
    p.generalTargetAccountId = merged.generalTargetAccountId;
    p.amountSettled = figures.amountSettled;
    p.cashReceived = figures.cashReceived;
    p.taxDeductedAtSource = figures.taxDeductedAtSource;
    p.chequeTxnRef = merged.chequeTxnRef ?? null;
    p.narration = merged.narration ?? null;
  }

  /** DRAFT + all required fields present (FR-REC-001..005). */
  assertPostable(): void {
    this.assertDraft();
    this.assertSettledComposition();
    this.assertReferenceXor();
    this.assertChequeRef();
    if (this._props.receiptType === 'IPC_LINKED' && !this._props.projectId) {
      throw new ValidationError('projectId is required for an IPC-linked receipt', { receiptId: this.id });
    }
    if (!this._props.purposeId) {
      throw new ValidationError('purposeId is required to post a receipt', { receiptId: this.id });
    }
  }

  /** amountSettled <= IPC outstanding — FR-REC-017 (IPC-linked only). */
  assertWithinOutstanding(ipcOutstanding: Money): void {
    if (this._props.amountSettled.amount.greaterThan(ipcOutstanding.amount)) {
      throw new OverApplicationError(
        this._props.amountSettled.amount.toFixed(MONEY_SCALE),
        ipcOutstanding.amount.toFixed(MONEY_SCALE),
      );
    }
  }

  /** DRAFT -> POSTED. */
  markPosted(entryId: string, entryNo: string, by: string, at: Date): void {
    this.assertDraft();
    this._props.status = 'POSTED';
    this._props.journalEntryId = entryId;
    this._props.entryNo = entryNo;
    this._props.postedBy = by;
    this._props.postedAt = at;
    void entryId;
  }

  /** POSTED -> CANCELLED. */
  markCancelled(): void {
    if (this._props.status !== 'POSTED') throw new NotPostedError(this._props.status);
    this._props.status = 'CANCELLED';
  }

  assertDraftForEdit(): void {
    this.assertDraft();
  }

  assertCancellable(): void {
    if (this._props.status !== 'POSTED') throw new NotPostedError(this._props.status);
  }

  private assertDraft(): void {
    if (this._props.status !== 'DRAFT') throw new NotDraftError(this._props.status);
  }

  get props(): Readonly<ReceiptProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
  get isIpcLinked(): boolean {
    return this._props.receiptType === 'IPC_LINKED';
  }

  // ---- invariants (private) --------------------------------------------------------------------

  /** amountSettled = cashReceived + taxDeductedAtSource, all >= 0, settled > 0 — FR-REC-019/-020. */
  private assertSettledComposition(): void {
    Receipt.assertComposition(this._props.amountSettled, this._props.cashReceived, this._props.taxDeductedAtSource);
  }

  /** exactly one of ipcId / generalTargetAccountId, matching receiptType — FR-REC-001. */
  private assertReferenceXor(): void {
    Receipt.assertReferenceXorStatic(this._props.receiptType, this._props.ipcId, this._props.generalTargetAccountId);
  }

  /** cheque_txn_ref present for MFS|BANK_TRANSFER|CHEQUE — FR-REC-004. */
  private assertChequeRef(): void {
    Receipt.assertChequeRefStatic(this._props.paymentMode, this._props.chequeTxnRef);
  }

  // ---- figures (pure math) -----------------------------------------------------------------------

  /**
   * Compute amountSettled/cashReceived/taxDeductedAtSource from the input. `cashReceived` is DERIVED =
   * amountSettled - taxDeductedAtSource (design §2.1; API contract). All arithmetic is exact Decimal,
   * rounded to 4dp.
   */
  private static computeFigures(input: NewReceipt): {
    amountSettled: Money;
    cashReceived: Money;
    taxDeductedAtSource: Money;
  } {
    const settledDec = round4(toDecimal(input.amountSettled, 'amountSettled'));
    const taxDec =
      input.taxDeductedAtSource !== undefined && input.taxDeductedAtSource !== null
        ? round4(assertNonNeg(toDecimal(input.taxDeductedAtSource, 'taxDeductedAtSource'), 'taxDeductedAtSource'))
        : new Decimal(0);
    const cashDec = settledDec.minus(taxDec);

    Receipt.assertComposition(Money.of(settledDec), Money.of(cashDec), Money.of(taxDec));

    return {
      amountSettled: Money.of(settledDec),
      cashReceived: Money.of(cashDec),
      taxDeductedAtSource: Money.of(taxDec),
    };
  }

  private static assertComposition(amountSettled: Money, cashReceived: Money, taxDeductedAtSource: Money): void {
    if (!amountSettled.amount.greaterThan(0)) {
      throw new SettledAmountInvalidError(
        `amountSettled must be > 0 (was ${amountSettled.amount.toFixed(MONEY_SCALE)})`,
        { amountSettled: amountSettled.amount.toFixed(MONEY_SCALE) },
      );
    }
    if (cashReceived.amount.isNegative()) {
      throw new SettledAmountInvalidError(
        `cashReceived must be >= 0 (was ${cashReceived.amount.toFixed(MONEY_SCALE)}); taxDeductedAtSource cannot exceed amountSettled`,
        { cashReceived: cashReceived.amount.toFixed(MONEY_SCALE) },
      );
    }
    if (taxDeductedAtSource.amount.isNegative()) {
      throw new SettledAmountInvalidError(
        `taxDeductedAtSource must be >= 0 (was ${taxDeductedAtSource.amount.toFixed(MONEY_SCALE)})`,
        { taxDeductedAtSource: taxDeductedAtSource.amount.toFixed(MONEY_SCALE) },
      );
    }
    if (!amountSettled.amount.equals(cashReceived.amount.plus(taxDeductedAtSource.amount))) {
      throw new SettledAmountInvalidError(
        `amountSettled (${amountSettled.amount.toFixed(MONEY_SCALE)}) must equal cashReceived + taxDeductedAtSource ` +
          `(${cashReceived.amount.toFixed(MONEY_SCALE)} + ${taxDeductedAtSource.amount.toFixed(MONEY_SCALE)})`,
        {
          amountSettled: amountSettled.amount.toFixed(MONEY_SCALE),
          cashReceived: cashReceived.amount.toFixed(MONEY_SCALE),
          taxDeductedAtSource: taxDeductedAtSource.amount.toFixed(MONEY_SCALE),
        },
      );
    }
  }

  private static assertReferenceXorStatic(
    receiptType: ReceiptType,
    ipcId: string | null,
    generalTargetAccountId: string | null,
  ): void {
    const hasIpc = !!ipcId;
    const hasGeneral = !!generalTargetAccountId;
    if (hasIpc === hasGeneral) {
      throw new ReferenceXorError();
    }
    if (receiptType === 'IPC_LINKED' && !hasIpc) throw new ReferenceXorError();
    if (receiptType === 'GENERAL' && !hasGeneral) throw new ReferenceXorError();
  }

  private static assertChequeRefStatic(mode: PaymentMode, chequeTxnRef: string | null): void {
    if (requiresChequeRef(mode) && !(chequeTxnRef && chequeTxnRef.trim())) {
      throw new ChequeRefMissingError(mode);
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------------

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
