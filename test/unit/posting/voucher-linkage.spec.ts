/**
 * buildVoucherLinkage (pure) — the shared cancel/repost chain view reused by SAL IPC, REC receipts, and
 * PAY payments (FR-*-022 family). Covers the four real chains: plain posted, cancelled, corrected
 * (reposted), and reposted-twice.
 */
import {
  buildVoucherLinkage,
  VoucherLedgerEntryRef,
} from '../../../src/core/posting/read/voucher-linkage';

const ref = (
  entryId: string,
  entryNo: string,
  isReversal: boolean,
  reversalOfEntryId: string | null,
  postedAt = '2026-06-29T10:00:00.000Z',
): VoucherLedgerEntryRef => ({ entryId, entryNo, isReversal, reversalOfEntryId, postedAt });

describe('buildVoucherLinkage', () => {
  it('plain POSTED voucher — single entry, no history, panel hidden', () => {
    const l = buildVoucherLinkage([ref('A', 'RV/2526/0007', false, null)], 'A', false);
    expect(l.hasHistory).toBe(false);
    expect(l.currentEntryNo).toBe('RV/2526/0007');
    expect(l.originalEntryNo).toBe('RV/2526/0007');
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0]).toMatchObject({ isCurrent: true, isReversed: false, reversedByEntryNo: null });
  });

  it('CANCELLED voucher — original retained + "reversed by", current stays the original', () => {
    const entries = [ref('A', 'RV/2526/0007', false, null), ref('B', 'RV/2526/0011', true, 'A')];
    const l = buildVoucherLinkage(entries, 'A', true);

    expect(l.hasHistory).toBe(true);
    expect(l.currentEntryNo).toBe('RV/2526/0007');
    expect(l.originalEntryNo).toBe('RV/2526/0007');
    expect(l.entries.find((e) => e.entryId === 'A')).toMatchObject({
      isCurrent: true,
      isReversed: true,
      reversedByEntryNo: 'RV/2526/0011',
    });
    expect(l.entries.find((e) => e.entryId === 'B')).toMatchObject({
      isReversal: true,
      reversalOfEntryNo: 'RV/2526/0007',
      isCurrent: false,
    });
  });

  it('CORRECTED (reposted) voucher — original superseded → reversal → corrected current', () => {
    const entries = [
      ref('A', 'PV/2526/0007', false, null, '2026-06-29T10:00:00.000Z'),
      ref('B', 'PV/2526/0011', true, 'A', '2026-06-30T10:00:00.000Z'),
      ref('C', 'PV/2526/0012', false, null, '2026-06-30T10:00:00.000Z'),
    ];
    const l = buildVoucherLinkage(entries, 'C', false);

    expect(l.hasHistory).toBe(true);
    expect(l.currentEntryNo).toBe('PV/2526/0012');
    expect(l.originalEntryNo).toBe('PV/2526/0007');
    expect(l.entries.find((e) => e.entryId === 'A')).toMatchObject({
      isCurrent: false,
      isReversed: true,
      reversedByEntryNo: 'PV/2526/0011',
    });
    expect(l.entries.find((e) => e.entryId === 'C')).toMatchObject({
      isCurrent: true,
      isReversed: false,
      isReversal: false,
    });
  });

  it('reposted TWICE — original earliest, current latest corrected', () => {
    const entries = [
      ref('A', 'PV/2526/0007', false, null),
      ref('B', 'PV/2526/0011', true, 'A'),
      ref('C', 'PV/2526/0012', false, null),
      ref('D', 'PV/2526/0015', true, 'C'),
      ref('E', 'PV/2526/0016', false, null),
    ];
    const l = buildVoucherLinkage(entries, 'E', false);
    expect(l.originalEntryNo).toBe('PV/2526/0007');
    expect(l.currentEntryNo).toBe('PV/2526/0016');
    expect(l.entries.find((e) => e.entryId === 'C')).toMatchObject({
      isReversed: true,
      reversedByEntryNo: 'PV/2526/0015',
      isCurrent: false,
    });
  });
});
