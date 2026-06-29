/**
 * JournalEntry / JournalLine domain unit tests (no DB/Nest) — balance, line-side, min-lines,
 * exact-decimal, reverse-swaps (FR-LED-007/008/009/014/025). 100% on the posting domain structure.
 */
import { JournalEntry, NewEntry } from '../../../src/core/posting/domain/journal-entry';
import { Money } from '../../../src/common/money';
import {
  LedgerImbalanceError,
  LineSideError,
  MinLinesError,
} from '../../../src/core/posting/domain/errors';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Clock } from '../../../src/common/ports/clock.port';

const ids: IdGenerator = { next: () => 'entry-1' };
const clock: Clock = { now: () => new Date('2026-07-15T10:00:00Z') };

function entry(lines: NewEntry['lines']): NewEntry {
  return {
    companyId: 'co-1',
    financialYearId: 'fy-1',
    entryNo: 'JV/2526/0001',
    voucherType: 'JOURNAL',
    voucherDate: '2025-07-15',
    sourceType: 'JOURNAL',
    sourceId: 'src-1',
    postedBy: 'user-1',
    lines,
  };
}

describe('JournalEntry (domain)', () => {
  it('creates a balanced entry and stamps posted_at, is_reversal=false', () => {
    const e = JournalEntry.create(
      entry([
        { accountId: 'a1', debit: Money.of('100.0000'), credit: Money.zero() },
        { accountId: 'a2', debit: Money.zero(), credit: Money.of('100.0000') },
      ]),
      ids,
      clock,
    );
    expect(e.id).toBe('entry-1');
    expect(e.props.isReversal).toBe(false);
    expect(e.props.reversalOf).toBeNull();
    expect(e.props.postedAt).toEqual(new Date('2026-07-15T10:00:00Z'));
    expect(e.totalDebit().equals(Money.of('100.0000'))).toBe(true);
  });

  it('rejects an unbalanced entry (FR-LED-014)', () => {
    expect(() =>
      JournalEntry.create(
        entry([
          { accountId: 'a1', debit: Money.of('100.0000'), credit: Money.zero() },
          { accountId: 'a2', debit: Money.zero(), credit: Money.of('90.0000') },
        ]),
        ids,
        clock,
      ),
    ).toThrow(LedgerImbalanceError);
  });

  it('rejects a line with both sides non-zero, both zero, or negative (FR-LED-008)', () => {
    expect(() =>
      JournalEntry.create(
        entry([
          { accountId: 'a1', debit: Money.of('100.0000'), credit: Money.of('100.0000') },
          { accountId: 'a2', debit: Money.zero(), credit: Money.of('100.0000') },
        ]),
        ids,
        clock,
      ),
    ).toThrow(LineSideError);
    expect(() =>
      JournalEntry.create(
        entry([
          { accountId: 'a1', debit: Money.of('-100.0000'), credit: Money.zero() },
          { accountId: 'a2', debit: Money.zero(), credit: Money.of('-100.0000') },
        ]),
        ids,
        clock,
      ),
    ).toThrow(LineSideError);
  });

  it('requires at least two lines (FR-LED-009)', () => {
    expect(() =>
      JournalEntry.create(entry([{ accountId: 'a1', debit: Money.of('100.0000'), credit: Money.zero() }]), ids, clock),
    ).toThrow(MinLinesError);
  });

  it('compares balance with EXACT decimal — 0.1 + 0.2 = 0.3 (no float drift) (FR-LED-007)', () => {
    const e = JournalEntry.create(
      entry([
        { accountId: 'a1', debit: Money.of('0.1000'), credit: Money.zero() },
        { accountId: 'a2', debit: Money.of('0.2000'), credit: Money.zero() },
        { accountId: 'a3', debit: Money.zero(), credit: Money.of('0.3000') },
      ]),
      ids,
      clock,
    );
    expect(e.totalDebit().equals(Money.of('0.3000'))).toBe(true);
  });

  it('reverse() swaps Dr<->Cr, sets is_reversal/reversal_of, leaves the original unchanged (FR-LED-025)', () => {
    const original = JournalEntry.create(
      entry([
        { accountId: 'a1', debit: Money.of('100.0000'), credit: Money.zero() },
        { accountId: 'a2', debit: Money.zero(), credit: Money.of('100.0000') },
      ]),
      { next: () => 'orig-1' },
      clock,
    );
    const reversal = original.reverse('correction', 'JV/2526/0002', 'user-9', { next: () => 'rev-1' }, clock);
    expect(reversal.props.isReversal).toBe(true);
    expect(reversal.props.reversalOf).toBe('orig-1');
    expect(reversal.props.postedBy).toBe('user-9');
    expect(reversal.props.lines[0].credit.equals(Money.of('100.0000'))).toBe(true); // was debit
    expect(reversal.props.lines[1].debit.equals(Money.of('100.0000'))).toBe(true); // was credit
    // original intact
    expect(original.props.isReversal).toBe(false);
    expect(original.props.lines[0].debit.equals(Money.of('100.0000'))).toBe(true);
  });
});
