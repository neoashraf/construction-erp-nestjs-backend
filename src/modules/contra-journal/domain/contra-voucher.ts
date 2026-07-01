/**
 * ContraVoucher aggregate + ContraLine (PURE — no NestJS/TypeORM). A draft→post→cancel voucher moving
 * funds strictly between the company's own bank/cash accounts (FR-GEN-001). It enforces GEN's voucher
 * SHAPE rules — ≥2 lines, line side (exactly one of debit/credit non-zero, both ≥0), the bank/cash
 * account restriction, and "no party" (FR-GEN-002/-003) — and builds a balanced `PostingCommand`
 * (voucherType=CONTRA, no required dimensions). It does NOT check balance/period/project/tags/number:
 * those are LED/PER/MAS policy applied by PostingService at post (design §2.1).
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import { PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { AccountClassificationSnapshot } from './ports/account-classification.port';
import {
  ContraPartyNotAllowedError,
  NotBankCashAccountError,
  NotDraftError,
  UnbalancedEntryError,
} from './errors';
import { VoucherStatus } from './voucher-status';

export const CONTRA_SOURCE_TYPE = 'ContraVoucher';

export interface NewContraLine {
  accountId: string;
  debit?: Decimal | string | number | null;
  credit?: Decimal | string | number | null;
  narration?: string | null;
}

export interface NewContra {
  voucherDate: string; // 'YYYY-MM-DD'
  narration?: string | null;
  lines: NewContraLine[];
}

export interface ContraLineProps {
  lineNo: number;
  accountId: string;
  debit: Decimal;
  credit: Decimal;
  narration: string | null;
}

export class ContraLine {
  private constructor(readonly props: ContraLineProps) {}

  static create(input: NewContraLine, lineNo: number): ContraLine {
    const debit = toMoney(input.debit);
    const credit = toMoney(input.credit);
    assertLineSide(debit, credit, lineNo);
    return new ContraLine({
      lineNo,
      accountId: req(input.accountId, 'accountId'),
      debit,
      credit,
      narration: input.narration ?? null,
    });
  }

  static rehydrate(props: ContraLineProps): ContraLine {
    return new ContraLine(props);
  }
}

export interface ContraVoucherProps {
  companyId: string;
  financialYearId: string;
  voucherDate: string;
  narration: string | null;
  status: VoucherStatus;
  entryNo: string | null;
  journalEntryId: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  version: number;
  lines: ContraLine[];
}

export class ContraVoucher extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: ContraVoucherProps,
  ) {
    super(id);
  }

  /**
   * Build a DRAFT contra. Rejects any line whose account is not bank/cash (NotBankCashAccountError,
   * FR-GEN-003), enforces ≥2 lines + the line side, and pre-flight balance. `classify` is a resolved
   * in-memory snapshot (no IO in the aggregate).
   */
  static createDraft(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewContra,
    classify: AccountClassificationSnapshot,
  ): ContraVoucher {
    const lines = ContraVoucher.buildLines(input, classify);
    return new ContraVoucher(id, {
      companyId,
      financialYearId,
      voucherDate: req(input.voucherDate, 'voucherDate'),
      narration: input.narration ?? null,
      status: 'DRAFT',
      entryNo: null,
      journalEntryId: null,
      postedAt: null,
      postedBy: null,
      version: 1,
      lines,
    });
  }

  static rehydrate(id: string, props: ContraVoucherProps): ContraVoucher {
    return new ContraVoucher(id, props);
  }

  /** Replace the draft's content. Only while DRAFT (NotDraftError, FR-GEN-014). */
  updateDraft(input: NewContra, classify: AccountClassificationSnapshot): void {
    this.assertDraft();
    this._props.voucherDate = req(input.voucherDate, 'voucherDate');
    this._props.narration = input.narration ?? null;
    this._props.lines = ContraVoucher.buildLines(input, classify);
  }

  private static buildLines(input: NewContra, classify: AccountClassificationSnapshot): ContraLine[] {
    if (!input.lines || input.lines.length < 2) {
      throw new ValidationError('A contra voucher requires at least 2 lines', { lines: input.lines?.length ?? 0 });
    }
    const lines = input.lines.map((l, i) => ContraLine.create(l, i + 1));
    for (const line of lines) {
      const facts = classify.factsFor(line.props.accountId);
      if (!facts.isCashBank) throw new NotBankCashAccountError(line.props.accountId);
      if (facts.isArApControl) throw new ContraPartyNotAllowedError(line.props.accountId);
    }
    assertBalanced(lines.map((l) => ({ debit: l.props.debit, credit: l.props.credit })));
    return lines;
  }

  /** Build the balanced CONTRA PostingCommand (no required dimensions, no party — FR-GEN-002). */
  toPostingCommand(postedBy: string): PostingCommand {
    const lines: PostingLine[] = this._props.lines.map((l) => ({
      accountId: l.props.accountId,
      debit: Money.of(l.props.debit),
      credit: Money.of(l.props.credit),
      narration: l.props.narration ?? undefined,
      accountType: 'ASSET',
      isControlAccount: false,
    }));
    return {
      companyId: this._props.companyId,
      financialYearId: this._props.financialYearId,
      voucherType: 'CONTRA',
      voucherDate: this._props.voucherDate,
      sourceType: CONTRA_SOURCE_TYPE,
      sourceId: this.id,
      postedBy,
      narration: this._props.narration ?? undefined,
      lines,
    };
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

  get props(): Readonly<ContraVoucherProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
}

// ---- shared helpers (also used by JournalVoucher) -------------------------------------------------

export function toMoney(value: Decimal | string | number | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  let d: Decimal;
  try {
    d = value instanceof Decimal ? value : new Decimal(value);
  } catch {
    throw new ValidationError('amount is not a valid number', { value: String(value) });
  }
  if (!d.isFinite()) throw new ValidationError('amount must be a finite number', { value: String(value) });
  return d;
}

export function assertLineSide(debit: Decimal, credit: Decimal, lineNo: number): void {
  if (debit.isNegative() || credit.isNegative()) {
    throw new ValidationError('debit and credit must both be >= 0', { lineNo });
  }
  if (debit.isZero() === credit.isZero()) {
    // both zero or both non-zero → invalid line side
    throw new ValidationError('exactly one of debit/credit must be non-zero', { lineNo });
  }
}

export function assertBalanced(lines: { debit: Decimal; credit: Decimal }[]): void {
  const dr = lines.reduce((s, l) => s.plus(l.debit), new Decimal(0));
  const cr = lines.reduce((s, l) => s.plus(l.credit), new Decimal(0));
  if (!dr.equals(cr)) throw new UnbalancedEntryError(dr.toFixed(4), cr.toFixed(4));
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}
