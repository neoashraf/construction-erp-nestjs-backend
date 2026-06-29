/**
 * JournalEntry aggregate root + JournalLine (PURE — no NestJS/TypeORM). Enforces the STRUCTURAL
 * invariants at construction so an invalid entry cannot exist in memory (ADR-0001 #1/#4):
 *   - each line: exactly one of debit/credit non-zero, both ≥ 0 (FR-LED-008);
 *   - entry: ≥ 2 lines (FR-LED-009) and Σdebit = Σcredit as EXACT Decimal (FR-LED-014).
 * It knows nothing about period/project/tag-matrix/numbering — those are application policy via ports.
 * `reverse()`/`swapped()` build a NEW reversal entry (Dr↔Cr swapped); the original is never mutated.
 */
import { AggregateRoot } from '../../../common/domain/domain';
import { Money } from '../../../common/money';
import { Clock } from '../../../common/ports/clock.port';
import { IdGenerator } from '../../../common/ports/id-generator.port';
import { LedgerImbalanceError, LineSideError, MinLinesError } from './errors';
import { VoucherType } from './voucher-type';

export interface NewLine {
  accountId: string;
  projectId?: string | null;
  costCentreId?: string | null;
  purposeId?: string | null;
  godownId?: string | null;
  partyId?: string | null;
  debit: Money;
  credit: Money;
  narration?: string | null;
}

export interface LineProps {
  accountId: string;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  godownId: string | null;
  partyId: string | null;
  debit: Money;
  credit: Money;
  narration: string | null;
}

export class JournalLine {
  private constructor(
    readonly lineNo: number,
    readonly props: LineProps,
  ) {}

  /** Create a line, enforcing the side invariant (FR-LED-008). */
  static create(input: NewLine, lineNo: number): JournalLine {
    if (input.debit.isNegative() || input.credit.isNegative()) {
      throw new LineSideError('debit and credit must both be >= 0', { lineNo });
    }
    const debitZero = input.debit.amount.isZero();
    const creditZero = input.credit.amount.isZero();
    if (debitZero === creditZero) {
      throw new LineSideError('exactly one of debit/credit must be non-zero', { lineNo });
    }
    return new JournalLine(lineNo, {
      accountId: input.accountId,
      projectId: input.projectId ?? null,
      costCentreId: input.costCentreId ?? null,
      purposeId: input.purposeId ?? null,
      godownId: input.godownId ?? null,
      partyId: input.partyId ?? null,
      debit: input.debit,
      credit: input.credit,
      narration: input.narration ?? null,
    });
  }

  /** Rehydrate a persisted line (trusted; no re-validation). */
  static rehydrate(lineNo: number, props: LineProps): JournalLine {
    return new JournalLine(lineNo, props);
  }

  /** Dr↔Cr swapped copy, for reversal entries (FR-LED-025). */
  swapped(lineNo: number): JournalLine {
    return new JournalLine(lineNo, { ...this.props, debit: this.props.credit, credit: this.props.debit });
  }

  get debit(): Money {
    return this.props.debit;
  }
  get credit(): Money {
    return this.props.credit;
  }
}

export interface NewEntry {
  companyId: string;
  financialYearId: string;
  entryNo: string;
  voucherType: VoucherType;
  voucherDate: string;
  sourceType: string;
  sourceId: string;
  postedBy: string;
  narration?: string | null;
  lines: NewLine[];
}

export interface JournalEntryProps {
  companyId: string;
  financialYearId: string;
  entryNo: string;
  voucherType: VoucherType;
  voucherDate: string;
  sourceType: string;
  sourceId: string;
  isReversal: boolean;
  reversalOf: string | null;
  postedAt: Date;
  postedBy: string;
  narration: string | null;
  lines: JournalLine[];
}

export class JournalEntry extends AggregateRoot<string> {
  private constructor(
    id: string,
    readonly props: JournalEntryProps,
  ) {
    super(id);
  }

  /** Build a normal, balanced entry. Min-lines + balance enforced here (FR-LED-009/014). */
  static create(input: NewEntry, ids: IdGenerator, clock: Clock): JournalEntry {
    const lines = input.lines.map((l, i) => JournalLine.create(l, i + 1));
    JournalEntry.assertMinLines(lines);
    JournalEntry.assertBalanced(lines);
    return new JournalEntry(ids.next(), {
      companyId: input.companyId,
      financialYearId: input.financialYearId,
      entryNo: input.entryNo,
      voucherType: input.voucherType,
      voucherDate: input.voucherDate,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      isReversal: false,
      reversalOf: null,
      postedAt: clock.now(),
      postedBy: input.postedBy,
      narration: input.narration ?? null,
      lines,
    });
  }

  /**
   * Validate line invariants + min-lines + balance WITHOUT building the aggregate or needing an
   * entry_no — so PostingService can fail fast before allocating a number (FR-LED-020, AC8). Throws the
   * same errors as `create`.
   */
  static assertPostable(lines: NewLine[]): void {
    const built = lines.map((l, i) => JournalLine.create(l, i + 1));
    JournalEntry.assertMinLines(built);
    JournalEntry.assertBalanced(built);
  }

  /** Rehydrate a persisted entry (trusted). */
  static rehydrate(id: string, props: JournalEntryProps): JournalEntry {
    return new JournalEntry(id, props);
  }

  /**
   * Build a NEW reversal entry mirroring this one with Dr↔Cr swapped; posted by the reversing actor.
   * The original is never mutated (FR-LED-025). The new entry carries a fresh entry_no, is_reversal=true
   * and reversal_of=this.id.
   */
  reverse(reason: string, entryNo: string, postedBy: string, ids: IdGenerator, clock: Clock): JournalEntry {
    const lines = this.props.lines.map((l, i) => l.swapped(i + 1));
    return new JournalEntry(ids.next(), {
      ...this.props,
      entryNo,
      isReversal: true,
      reversalOf: this.id,
      postedAt: clock.now(),
      postedBy,
      narration: `Reversal: ${reason}`,
      lines,
    });
  }

  totalDebit(): Money {
    return this.props.lines.reduce((s, l) => s.plus(l.debit), Money.zero());
  }

  private static assertMinLines(lines: JournalLine[]): void {
    if (lines.length < 2) throw new MinLinesError(lines.length);
  }

  private static assertBalanced(lines: JournalLine[]): void {
    const dr = lines.reduce((s, l) => s.plus(l.debit), Money.zero());
    const cr = lines.reduce((s, l) => s.plus(l.credit), Money.zero());
    if (!dr.equals(cr)) throw new LedgerImbalanceError(dr.amount.toFixed(4), cr.amount.toFixed(4));
  }
}
