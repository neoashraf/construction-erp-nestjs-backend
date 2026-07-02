/**
 * PaymentVoucher aggregate root (PURE — no NestJS/TypeORM). The cash-out voucher in a
 * draft->posted->cancelled lifecycle. It OWNS the money composition (payment amount, bank charges, the
 * per-payable allocations) + the lifecycle. It does NOT know the period, the tag matrix, numbering, the
 * payable's control account, or how the ledger is written — those are resolved by the use case (via
 * PayableLookup + PaymentAccountMap) and turned into a balanced PostingCommand by payment-posting.ts. A
 * payment SETTLES a payable (Dr control/liability) and pays cash (Cr bank/cash/MFS); it NEVER re-expenses
 * a settlement (CLAUDE.md load-bearing rule). The ONLY P&L lines are bank charges + the daily-labour
 * accrued-vs-paid true-up, both built in payment-posting.ts.
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { Money, MONEY_SCALE } from '../../../common/money';
import { AccountType } from '../../../core/posting/domain/posting-command';
import { ValidationError } from '../../../common/errors/domain-error';
import { PaymentMode, requiresChequeRef } from './payment-mode';
import { PayableType, PaymentAllocation } from './allocation';
import { ChequeRefMissingError, NotDraftError, NotPostedError, OverAllocationError } from './errors';

export const PAYMENT_SOURCE_TYPE = 'PaymentVoucher';

export type PaymentStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';
export const PAYMENT_STATUSES: readonly PaymentStatus[] = ['DRAFT', 'POSTED', 'CANCELLED'] as const;

/** A single payable to settle, as the caller supplies it (the control account/dims are resolved later). */
export interface NewPaymentAllocation {
  payableType: PayableType;
  payableId: string;
  amountAllocated: Decimal | string | number;
}

/** Fields the caller supplies to build/edit a draft. Money-ish values accept string/number/Decimal. */
export interface NewPayment {
  partyId?: string | null;
  paymentDate: string; // 'YYYY-MM-DD'
  paymentMode: PaymentMode;
  paymentAccountId: string;
  chequeTxnRef?: string | null;
  bankChargesAmount?: Decimal | string | number | null;
  bankChargesProjectId?: string | null;
  bankChargesCostCentreId?: string | null;
  bankChargesPurposeId?: string | null;
  paymentAmount: Decimal | string | number;
  narration?: string | null;
  allocations: NewPaymentAllocation[];
}

/** A PATCH: any of NewPayment's fields; omitted fields keep the draft's current value. */
export type EditPayment = Partial<NewPayment>;

/** The resolved payable binding applied to an allocation before the command is built. */
export interface ResolvedAllocation {
  controlAccountId: string;
  controlAccountType: AccountType;
  isControlAccount: boolean;
  partyId: string | null;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  accruedAmount: Money | null;
}

export interface PaymentProps {
  companyId: string;
  financialYearId: string;
  partyId: string | null;
  paymentDate: string;
  paymentMode: PaymentMode;
  paymentAccountId: string;
  chequeTxnRef: string | null;
  bankChargesAmount: Money;
  bankChargesProjectId: string | null;
  bankChargesCostCentreId: string | null;
  bankChargesPurposeId: string | null;
  paymentAmount: Money;
  narration: string | null;
  status: PaymentStatus;
  entryNo: string | null;
  journalEntryId: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  allocations: PaymentAllocation[];
  version: number;
}

export class PaymentVoucher extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: PaymentProps,
  ) {
    super(id);
  }

  /** Build a DRAFT payment. Validates composition (allocations within total, cheque-ref, charge tags). */
  static createDraft(id: string, companyId: string, financialYearId: string, input: NewPayment): PaymentVoucher {
    const props: PaymentProps = {
      companyId,
      financialYearId,
      partyId: input.partyId ?? null,
      paymentDate: req(input.paymentDate, 'paymentDate'),
      paymentMode: input.paymentMode,
      paymentAccountId: req(input.paymentAccountId, 'paymentAccountId'),
      chequeTxnRef: input.chequeTxnRef ?? null,
      bankChargesAmount: moneyNonNeg(input.bankChargesAmount ?? 0, 'bankChargesAmount'),
      bankChargesProjectId: input.bankChargesProjectId ?? null,
      bankChargesCostCentreId: input.bankChargesCostCentreId ?? null,
      bankChargesPurposeId: input.bankChargesPurposeId ?? null,
      paymentAmount: moneyNonNeg(input.paymentAmount, 'paymentAmount'),
      narration: input.narration ?? null,
      status: 'DRAFT',
      entryNo: null,
      journalEntryId: null,
      postedAt: null,
      postedBy: null,
      allocations: PaymentVoucher.buildAllocations(input.allocations),
      version: 1,
    };
    const v = new PaymentVoucher(id, props);
    v.assertInvariants();
    return v;
  }

  static rehydrate(id: string, props: PaymentProps): PaymentVoucher {
    return new PaymentVoucher(id, props);
  }

  /** Edit the draft in place (only while DRAFT). Re-validates composition. */
  updateDraft(patch: EditPayment): void {
    this.assertDraft();
    const p = this._props;
    p.partyId = patch.partyId !== undefined ? (patch.partyId ?? null) : p.partyId;
    p.paymentDate = req(patch.paymentDate ?? p.paymentDate, 'paymentDate');
    p.paymentMode = patch.paymentMode ?? p.paymentMode;
    p.paymentAccountId = req(patch.paymentAccountId ?? p.paymentAccountId, 'paymentAccountId');
    p.chequeTxnRef = patch.chequeTxnRef !== undefined ? (patch.chequeTxnRef ?? null) : p.chequeTxnRef;
    p.bankChargesAmount =
      patch.bankChargesAmount !== undefined
        ? moneyNonNeg(patch.bankChargesAmount ?? 0, 'bankChargesAmount')
        : p.bankChargesAmount;
    p.bankChargesProjectId =
      patch.bankChargesProjectId !== undefined ? (patch.bankChargesProjectId ?? null) : p.bankChargesProjectId;
    p.bankChargesCostCentreId =
      patch.bankChargesCostCentreId !== undefined ? (patch.bankChargesCostCentreId ?? null) : p.bankChargesCostCentreId;
    p.bankChargesPurposeId =
      patch.bankChargesPurposeId !== undefined ? (patch.bankChargesPurposeId ?? null) : p.bankChargesPurposeId;
    p.paymentAmount = patch.paymentAmount !== undefined ? moneyNonNeg(patch.paymentAmount, 'paymentAmount') : p.paymentAmount;
    p.narration = patch.narration !== undefined ? (patch.narration ?? null) : p.narration;
    if (patch.allocations !== undefined) {
      p.allocations = PaymentVoucher.buildAllocations(patch.allocations);
    }
    this.assertInvariants();
  }

  /** Bind an allocation's resolved control account / dims / party / accrued (from PayableLookup). */
  applyResolvedPayable(lineNo: number, r: ResolvedAllocation): void {
    const a = this._props.allocations.find((x) => x.lineNo === lineNo);
    if (!a) throw new ValidationError(`Allocation line ${lineNo} not found`, { lineNo });
    a.controlAccountId = r.controlAccountId;
    a.controlAccountType = r.controlAccountType;
    a.isControlAccount = r.isControlAccount;
    a.partyId = r.partyId;
    a.projectId = r.projectId;
    a.costCentreId = r.costCentreId;
    a.purposeId = r.purposeId;
    a.accruedAmount = r.accruedAmount;
  }

  /** DRAFT + at least one allocation + required fields present + invariants hold. */
  assertPostable(): void {
    this.assertDraft();
    if (this._props.allocations.length === 0) {
      throw new ValidationError('A payment requires at least one allocation to post', { id: this.id });
    }
    if (!this._props.paymentAccountId) {
      throw new ValidationError('paymentAccountId is required to post a payment', { id: this.id });
    }
    this.assertInvariants();
  }

  /** DRAFT -> POSTED. */
  markPosted(entryId: string, entryNo: string, by: string, at: Date): void {
    this.assertDraft();
    this._props.status = 'POSTED';
    this._props.journalEntryId = entryId;
    this._props.entryNo = entryNo;
    this._props.postedBy = by;
    this._props.postedAt = at;
  }

  /** POSTED -> CANCELLED. */
  markCancelled(): void {
    if (this._props.status !== 'POSTED') throw new NotPostedError(this._props.status);
    this._props.status = 'CANCELLED';
  }

  assertCancellable(): void {
    if (this._props.status !== 'POSTED') throw new NotPostedError(this._props.status);
  }

  assertPosted(): void {
    if (this._props.status !== 'POSTED') throw new NotPostedError(this._props.status);
  }

  /** The bank-charge P&L line's dims + amount (for cost-control checks), or null if there is no charge. */
  chargeLine(): { projectId: string | null; costCentreId: string | null; purposeId: string | null; amount: Money } | null {
    if (!this._props.bankChargesAmount.amount.greaterThan(0)) return null;
    return {
      projectId: this._props.bankChargesProjectId,
      costCentreId: this._props.bankChargesCostCentreId,
      purposeId: this._props.bankChargesPurposeId,
      amount: this._props.bankChargesAmount,
    };
  }

  private assertDraft(): void {
    if (this._props.status !== 'DRAFT') throw new NotDraftError(this._props.status);
  }

  get props(): Readonly<PaymentProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }

  // ---- invariants (private) --------------------------------------------------------------------

  private assertInvariants(): void {
    this.assertAllocationsWithinTotal();
    this.assertChequeRefForNonCash();
    this.assertChargeTagsPresent();
  }

  /** Σ amountAllocated <= paymentAmount. */
  private assertAllocationsWithinTotal(): void {
    const allocated = this._props.allocations.reduce((s, a) => s.plus(a.amountAllocated.amount), new Decimal(0));
    if (allocated.greaterThan(this._props.paymentAmount.amount)) {
      throw new OverAllocationError(allocated.toFixed(MONEY_SCALE), this._props.paymentAmount.amount.toFixed(MONEY_SCALE));
    }
  }

  /** A non-cash mode requires a cheque/transaction reference. */
  private assertChequeRefForNonCash(): void {
    if (requiresChequeRef(this._props.paymentMode) && !(this._props.chequeTxnRef && this._props.chequeTxnRef.trim())) {
      throw new ChequeRefMissingError(this._props.paymentMode);
    }
  }

  /** A bank charge (> 0) must carry project + cost_centre + purpose (a P&L expense line needs all dims). */
  private assertChargeTagsPresent(): void {
    if (!this._props.bankChargesAmount.amount.greaterThan(0)) return;
    if (!this._props.bankChargesProjectId || !this._props.bankChargesCostCentreId || !this._props.bankChargesPurposeId) {
      throw new ValidationError('bankChargesAmount > 0 requires bankCharges project + cost centre + purpose', {
        id: this.id,
      });
    }
  }

  private static buildAllocations(inputs: NewPaymentAllocation[]): PaymentAllocation[] {
    return (inputs ?? []).map((a, i) => {
      const amount = round4(toDecimal(a.amountAllocated, `allocations[${i}].amountAllocated`));
      if (!amount.greaterThan(0)) {
        throw new ValidationError(`allocations[${i}].amountAllocated must be > 0`, { index: i });
      }
      return {
        lineNo: i + 1,
        payableType: a.payableType,
        payableId: req(a.payableId, `allocations[${i}].payableId`),
        amountAllocated: Money.of(amount),
        accruedAmount: null,
        partyId: null,
        projectId: null,
        costCentreId: null,
        purposeId: null,
      };
    });
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function round4(d: Decimal): Decimal {
  return d.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

function moneyNonNeg(value: Decimal | string | number, field: string): Money {
  const d = round4(toDecimal(value, field));
  if (d.isNegative()) throw new ValidationError(`${field} must be >= 0`, { field });
  return Money.of(d);
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

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}
