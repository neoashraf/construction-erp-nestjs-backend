/**
 * JournalVoucher aggregate + JournalLine draft (PURE — no NestJS/TypeORM). A draft→post→cancel voucher
 * for manual adjustments/provisions/accruals/manual-depreciation (voucherType=JOURNAL) and the one-time
 * go-live opening journal (voucherType=OPENING). It enforces GEN's voucher SHAPE + conditional tagging:
 *   - ≥2 lines, line side (exactly one of debit/credit non-zero, both ≥0), pre-flight balance;
 *   - P&L line (INCOME/EXPENSE account) requires project+cost_centre+purpose (FR-GEN-005);
 *   - balance-sheet-only line may be untagged (FR-GEN-006);
 *   - ANY line on an AR/AP control account requires a party (FR-GEN-007), regardless of voucher type.
 * These are resolved by GEN from the account classification and RE-ENFORCED by LED's TagMatrix at post
 * (defense-in-depth, design §1). The aggregate does not check period/project/number/final balance.
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import { AccountType, PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { VoucherType } from '../../../core/posting/domain/voucher-type';
import {
  assertBalanced,
  assertLineSide,
  toMoney,
} from './contra-voucher';
import { AccountClassificationSnapshot } from './ports/account-classification.port';
import {
  MissingControlPartyError,
  MissingPnlDimensionError,
  NotDraftError,
} from './errors';
import { VoucherStatus } from './voucher-status';

export const JOURNAL_SOURCE_TYPE = 'JournalVoucher';
export type JournalVoucherType = Extract<VoucherType, 'JOURNAL' | 'OPENING'>;
const PNL_TYPES = new Set<AccountType>(['INCOME', 'EXPENSE']);

export interface NewJournalLine {
  accountId: string;
  projectId?: string | null;
  costCentreId?: string | null;
  purposeId?: string | null;
  partyId?: string | null;
  debit?: Decimal | string | number | null;
  credit?: Decimal | string | number | null;
  narration?: string | null;
}

export interface NewJournal {
  voucherType?: JournalVoucherType; // defaults to JOURNAL
  voucherDate: string;
  narration?: string | null;
  lines: NewJournalLine[];
}

export interface JournalLineProps {
  lineNo: number;
  accountId: string;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  partyId: string | null;
  /** The line account's type + control flag, resolved at draft build (persisted for the command). */
  accountType: AccountType | null;
  isControlAccount: boolean;
  debit: Decimal;
  credit: Decimal;
  narration: string | null;
}

export class JournalLine {
  private constructor(readonly props: JournalLineProps) {}

  static create(
    input: NewJournalLine,
    lineNo: number,
    classify: AccountClassificationSnapshot,
  ): JournalLine {
    const accountId = req(input.accountId, 'accountId');
    const debit = toMoney(input.debit);
    const credit = toMoney(input.credit);
    assertLineSide(debit, credit, lineNo);

    const facts = classify.factsFor(accountId);
    const projectId = clean(input.projectId);
    const costCentreId = clean(input.costCentreId);
    const purposeId = clean(input.purposeId);
    const partyId = clean(input.partyId);

    // FR-GEN-005: a P&L line (INCOME/EXPENSE) must carry project + cost_centre + purpose.
    if (facts.type && PNL_TYPES.has(facts.type)) {
      if (!projectId) throw new MissingPnlDimensionError(accountId, 'project_id');
      if (!costCentreId) throw new MissingPnlDimensionError(accountId, 'cost_centre_id');
      if (!purposeId) throw new MissingPnlDimensionError(accountId, 'purpose_id');
    }
    // FR-GEN-007: any AR/AP control-account line must carry a party (regardless of voucher type).
    if (facts.isArApControl && !partyId) {
      throw new MissingControlPartyError(accountId);
    }

    return new JournalLine({
      lineNo,
      accountId,
      projectId,
      costCentreId,
      purposeId,
      partyId,
      accountType: facts.type,
      isControlAccount: facts.isArApControl,
      debit,
      credit,
      narration: input.narration ?? null,
    });
  }

  static rehydrate(props: JournalLineProps): JournalLine {
    return new JournalLine(props);
  }
}

export interface JournalVoucherProps {
  companyId: string;
  financialYearId: string;
  voucherType: JournalVoucherType;
  voucherDate: string;
  narration: string | null;
  status: VoucherStatus;
  entryNo: string | null;
  journalEntryId: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  version: number;
  lines: JournalLine[];
}

export class JournalVoucher extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: JournalVoucherProps,
  ) {
    super(id);
  }

  static createDraft(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewJournal,
    classify: AccountClassificationSnapshot,
  ): JournalVoucher {
    const voucherType: JournalVoucherType = input.voucherType ?? 'JOURNAL';
    const lines = JournalVoucher.buildLines(input, classify);
    return new JournalVoucher(id, {
      companyId,
      financialYearId,
      voucherType,
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

  static rehydrate(id: string, props: JournalVoucherProps): JournalVoucher {
    return new JournalVoucher(id, props);
  }

  updateDraft(input: NewJournal, classify: AccountClassificationSnapshot): void {
    this.assertDraft();
    if (input.voucherType && input.voucherType !== this._props.voucherType) {
      throw new ValidationError('voucherType cannot be changed on an existing draft', {
        from: this._props.voucherType,
        to: input.voucherType,
      });
    }
    this._props.voucherDate = req(input.voucherDate, 'voucherDate');
    this._props.narration = input.narration ?? null;
    this._props.lines = JournalVoucher.buildLines(input, classify);
  }

  private static buildLines(input: NewJournal, classify: AccountClassificationSnapshot): JournalLine[] {
    if (!input.lines || input.lines.length < 2) {
      throw new ValidationError('A journal voucher requires at least 2 lines', { lines: input.lines?.length ?? 0 });
    }
    const lines = input.lines.map((l, i) => JournalLine.create(l, i + 1, classify));
    assertBalanced(lines.map((l) => ({ debit: l.props.debit, credit: l.props.credit })));
    return lines;
  }

  /** Build the balanced PostingCommand, passing the conditional tags + classification hints to LED. */
  toPostingCommand(postedBy: string): PostingCommand {
    const lines: PostingLine[] = this._props.lines.map((l) => ({
      accountId: l.props.accountId,
      projectId: l.props.projectId ?? undefined,
      costCentreId: l.props.costCentreId ?? undefined,
      purposeId: l.props.purposeId ?? undefined,
      partyId: l.props.partyId ?? undefined,
      debit: Money.of(l.props.debit),
      credit: Money.of(l.props.credit),
      narration: l.props.narration ?? undefined,
      accountType: l.props.accountType ?? undefined,
      isControlAccount: l.props.isControlAccount,
    }));
    return {
      companyId: this._props.companyId,
      financialYearId: this._props.financialYearId,
      voucherType: this._props.voucherType,
      voucherDate: this._props.voucherDate,
      sourceType: JOURNAL_SOURCE_TYPE,
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

  get props(): Readonly<JournalVoucherProps> {
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
