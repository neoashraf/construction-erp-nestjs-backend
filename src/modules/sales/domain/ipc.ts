/**
 * Ipc aggregate root (PURE — no NestJS/TypeORM). The customer-billing voucher (Interim Payment
 * Certificate) in a draft→posted→cancelled lifecycle. It OWNS the money math and the lifecycle:
 *   - retention  = round4(retentionRate × certified)   (overridable per-IPC — FR-SAL-006);
 *   - advance    = min(round4(advanceRate × certified), remainingAdvance)  (capped — FR-SAL-008);
 *   - outputVat  = round4(vatRate × certified)          (default; overridable);
 *   - currentlyDue (residual, the AR debit) = certified + outputVat − retention − advance − aitTds  (≥ 0).
 * It does NOT know about the period, the tag matrix, numbering, or how the ledger is written — those are
 * LED/PER policy reached via the use case. `currentlyDue` is recomputed on every draft edit and is the
 * single source of the AR amount, so the posting command always balances by construction (FR-SAL-004/011).
 * Line-to-account mapping lives in ipc-posting.ts; this file computes the figures + lifecycle only.
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import {
  AdvanceExceededError,
  CertifiedNotPositiveError,
  CurrentlyDueNegativeError,
  NotDraftError,
} from './errors';
import { IpcRates } from './rates';

export const IPC_SOURCE_TYPE = 'SalesInvoice';

export type IpcStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';
export const IPC_STATUSES: readonly IpcStatus[] = ['DRAFT', 'POSTED', 'CANCELLED'] as const;

const MONEY_SCALE = 4;

/** Fields the caller supplies to build/edit a draft. Money-ish values accept string/number/Decimal. */
export interface NewIpc {
  projectId: string;
  customerId: string;
  ipcSeqNo: number;
  ipcDate: string; // 'YYYY-MM-DD'
  billDate: string;
  dueDate: string;
  workCompletedPct: Decimal | string | number;
  certifiedAmount: Decimal | string | number;
  costCentreId: string;
  purposeId: string;
  /** Optional overrides; when omitted the rate-derived defaults are used. */
  outputVatAmount?: Decimal | string | number | null;
  aitTdsAmount?: Decimal | string | number | null;
  retentionAmount?: Decimal | string | number | null;
  advanceRecoveredAmount?: Decimal | string | number | null;
  narration?: string | null;
}

/** A PATCH: any of NewIpc's fields; omitted fields keep the draft's current value. */
export type EditIpc = Partial<NewIpc>;

export interface IpcProps {
  companyId: string;
  financialYearId: string;
  projectId: string;
  customerId: string;
  ipcSeqNo: number;
  ipcDate: string;
  billDate: string;
  dueDate: string;
  workCompletedPct: Decimal;
  certifiedAmount: Money;
  costCentreId: string;
  purposeId: string;
  outputVatAmount: Money;
  aitTdsAmount: Money;
  retentionAmount: Money;
  advanceRecoveredAmount: Money;
  currentlyDueAmount: Money; // residual — derived, the AR debit
  retentionRatePct: Decimal;
  advanceRatePct: Decimal;
  narration: string | null;
  status: IpcStatus;
  entryNo: string | null;
  journalEntryId: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  version: number;
}

export class Ipc extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: IpcProps,
  ) {
    super(id);
  }

  /**
   * Build a DRAFT IPC. Computes retention/advance/VAT (defaults from `rates`, overridable), caps advance
   * at `remainingAdvance`, and derives the residual currently-due (≥ 0). No number, no ledger impact.
   */
  static createDraft(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewIpc,
    rates: IpcRates,
    remainingAdvance: Money,
  ): Ipc {
    const figures = Ipc.computeFigures(input, rates, remainingAdvance);
    return new Ipc(id, {
      companyId,
      financialYearId,
      projectId: req(input.projectId, 'projectId'),
      customerId: req(input.customerId, 'customerId'),
      ipcSeqNo: reqSeqNo(input.ipcSeqNo),
      ipcDate: req(input.ipcDate, 'ipcDate'),
      billDate: req(input.billDate, 'billDate'),
      dueDate: reqDueDate(input.billDate, input.dueDate),
      workCompletedPct: figures.workCompletedPct,
      certifiedAmount: figures.certified,
      costCentreId: req(input.costCentreId, 'costCentreId'),
      purposeId: req(input.purposeId, 'purposeId'),
      outputVatAmount: figures.outputVat,
      aitTdsAmount: figures.aitTds,
      retentionAmount: figures.retention,
      advanceRecoveredAmount: figures.advance,
      currentlyDueAmount: figures.currentlyDue,
      retentionRatePct: figures.retentionRatePct,
      advanceRatePct: rates.advancePct,
      narration: input.narration ?? null,
      status: 'DRAFT',
      entryNo: null,
      journalEntryId: null,
      postedAt: null,
      postedBy: null,
      version: 1,
    });
  }

  static rehydrate(id: string, props: IpcProps): Ipc {
    return new Ipc(id, props);
  }

  /** Edit the draft in place (only while DRAFT — FR-SAL-023). Recomputes all figures on the new values. */
  updateDraft(patch: EditIpc, rates: IpcRates, remainingAdvance: Money): void {
    this.assertDraft();
    const p = this._props;
    const merged: NewIpc = {
      projectId: patch.projectId ?? p.projectId,
      customerId: patch.customerId ?? p.customerId,
      ipcSeqNo: patch.ipcSeqNo ?? p.ipcSeqNo,
      ipcDate: patch.ipcDate ?? p.ipcDate,
      billDate: patch.billDate ?? p.billDate,
      dueDate: patch.dueDate ?? p.dueDate,
      workCompletedPct: patch.workCompletedPct ?? p.workCompletedPct,
      certifiedAmount: patch.certifiedAmount ?? p.certifiedAmount.amount,
      costCentreId: patch.costCentreId ?? p.costCentreId,
      purposeId: patch.purposeId ?? p.purposeId,
      // For overridable figures a supplied value wins; otherwise re-derive from the (possibly new) rates.
      outputVatAmount: patch.outputVatAmount !== undefined ? patch.outputVatAmount : undefined,
      aitTdsAmount: patch.aitTdsAmount !== undefined ? patch.aitTdsAmount : p.aitTdsAmount.amount,
      retentionAmount: patch.retentionAmount !== undefined ? patch.retentionAmount : undefined,
      advanceRecoveredAmount:
        patch.advanceRecoveredAmount !== undefined ? patch.advanceRecoveredAmount : undefined,
      narration: patch.narration !== undefined ? patch.narration : p.narration,
    };
    const figures = Ipc.computeFigures(merged, rates, remainingAdvance);
    p.projectId = req(merged.projectId, 'projectId');
    p.customerId = req(merged.customerId, 'customerId');
    p.ipcSeqNo = reqSeqNo(merged.ipcSeqNo);
    p.ipcDate = req(merged.ipcDate, 'ipcDate');
    p.billDate = req(merged.billDate, 'billDate');
    p.dueDate = reqDueDate(merged.billDate, merged.dueDate);
    p.workCompletedPct = figures.workCompletedPct;
    p.certifiedAmount = figures.certified;
    p.costCentreId = req(merged.costCentreId, 'costCentreId');
    p.purposeId = req(merged.purposeId, 'purposeId');
    p.outputVatAmount = figures.outputVat;
    p.aitTdsAmount = figures.aitTds;
    p.retentionAmount = figures.retention;
    p.advanceRecoveredAmount = figures.advance;
    p.currentlyDueAmount = figures.currentlyDue;
    p.retentionRatePct = figures.retentionRatePct;
    p.advanceRatePct = rates.advancePct;
    p.narration = merged.narration ?? null;
  }

  /**
   * Re-cap advance recovery against the authoritative remaining advance read inside the post transaction
   * (FR-SAL-008). Rejects if the recorded recovery exceeds the fresh remaining (never silently widens it).
   */
  assertAdvanceWithinRemaining(remainingAdvance: Money): void {
    if (this._props.advanceRecoveredAmount.amount.greaterThan(remainingAdvance.amount)) {
      throw new AdvanceExceededError(
        this._props.advanceRecoveredAmount.amount.toFixed(MONEY_SCALE),
        remainingAdvance.amount.toFixed(MONEY_SCALE),
      );
    }
  }

  assertPostable(): void {
    this.assertDraft();
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
    if (this._props.status !== 'POSTED') throw new NotDraftError(this._props.status);
    this._props.status = 'CANCELLED';
  }

  private assertDraft(): void {
    if (this._props.status !== 'DRAFT') throw new NotDraftError(this._props.status);
  }

  get props(): Readonly<IpcProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }

  // ---- figures (pure math) -------------------------------------------------------------------------

  /**
   * Compute the five money figures + effective retention rate from the certified base and the rates.
   * Overrides (supplied outputVat/retention/advance) win over the rate default; advance is capped at the
   * remaining; the residual currentlyDue must be ≥ 0. All arithmetic is exact Decimal, rounded to 4dp.
   */
  private static computeFigures(
    input: NewIpc,
    rates: IpcRates,
    remainingAdvance: Money,
  ): {
    workCompletedPct: Decimal;
    certified: Money;
    outputVat: Money;
    aitTds: Money;
    retention: Money;
    advance: Money;
    currentlyDue: Money;
    retentionRatePct: Decimal;
  } {
    const certifiedDec = round4(toDecimal(input.certifiedAmount, 'certifiedAmount'));
    if (!certifiedDec.greaterThan(0)) throw new CertifiedNotPositiveError(certifiedDec.toFixed(MONEY_SCALE));
    const certified = Money.of(certifiedDec);

    const workCompletedPct = assertPct(toDecimal(input.workCompletedPct, 'workCompletedPct'));

    // Output VAT: override or rateVat × certified.
    const outputVatDec =
      input.outputVatAmount !== undefined && input.outputVatAmount !== null
        ? round4(assertNonNeg(toDecimal(input.outputVatAmount, 'outputVatAmount'), 'outputVatAmount'))
        : round4(certifiedDec.times(rates.vatFraction()));
    const outputVat = Money.of(outputVatDec);

    // AIT/TDS: entered by the customer's deduction; default 0.
    const aitTdsDec =
      input.aitTdsAmount !== undefined && input.aitTdsAmount !== null
        ? round4(assertNonNeg(toDecimal(input.aitTdsAmount, 'aitTdsAmount'), 'aitTdsAmount'))
        : new Decimal(0);
    const aitTds = Money.of(aitTdsDec);

    // Retention: override or rateRetention × certified. Record the effective rate for audit.
    let retentionDec: Decimal;
    let retentionRatePct: Decimal;
    if (input.retentionAmount !== undefined && input.retentionAmount !== null) {
      retentionDec = round4(assertNonNeg(toDecimal(input.retentionAmount, 'retentionAmount'), 'retentionAmount'));
      retentionRatePct = certifiedDec.isZero()
        ? rates.retentionPct
        : retentionDec.dividedBy(certifiedDec).times(100);
    } else {
      retentionDec = round4(certifiedDec.times(rates.retentionFraction()));
      retentionRatePct = rates.retentionPct;
    }
    const retention = Money.of(retentionDec);

    // Advance recovery: override or rateAdvance × certified, capped at the remaining advance.
    const rawAdvanceDec =
      input.advanceRecoveredAmount !== undefined && input.advanceRecoveredAmount !== null
        ? round4(
            assertNonNeg(toDecimal(input.advanceRecoveredAmount, 'advanceRecoveredAmount'), 'advanceRecoveredAmount'),
          )
        : round4(certifiedDec.times(rates.advanceFraction()));
    const cappedAdvanceDec = Decimal.min(rawAdvanceDec, remainingAdvance.amount);
    const advance = Money.of(cappedAdvanceDec);

    // Residual currently-due = certified + VAT − retention − advance − AIT/TDS (≥ 0).
    const currentlyDueDec = certifiedDec
      .plus(outputVatDec)
      .minus(retentionDec)
      .minus(cappedAdvanceDec)
      .minus(aitTdsDec);
    if (currentlyDueDec.isNegative()) {
      throw new CurrentlyDueNegativeError(currentlyDueDec.toFixed(MONEY_SCALE));
    }
    const currentlyDue = Money.of(round4(currentlyDueDec));

    return {
      workCompletedPct,
      certified,
      outputVat,
      aitTds,
      retention,
      advance,
      currentlyDue,
      retentionRatePct: round4(retentionRatePct),
    };
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

function assertPct(d: Decimal): Decimal {
  if (d.isNegative() || d.greaterThan(100)) {
    throw new ValidationError('workCompletedPct must be within [0, 100]', {
      workCompletedPct: d.toString(),
    });
  }
  return d;
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}

function reqSeqNo(seq: number): number {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new ValidationError('ipcSeqNo must be a positive integer', { ipcSeqNo: seq });
  }
  return seq;
}

function reqDueDate(billDate: string | undefined, dueDate: string | undefined): string {
  const bill = req(billDate ?? '', 'billDate');
  const due = req(dueDate ?? '', 'dueDate');
  if (due < bill) throw new ValidationError('dueDate must be >= billDate', { billDate: bill, dueDate: due });
  return due;
}
