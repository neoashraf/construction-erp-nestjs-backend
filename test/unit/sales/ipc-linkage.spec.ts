/**
 * buildIpcLinkage (pure) — cross-references source-filtered ledger entries into the IPC viewer's
 * cancel/repost linkage view (FR-SAL-022). Covers the three real chains: plain posted, cancelled,
 * and corrected (reposted, incl. twice).
 */
import { buildIpcLinkage } from '../../../src/modules/sales/application/ipc-linkage';
import { IpcLedgerEntryRef } from '../../../src/modules/sales/domain/ports/ipc-ledger-linkage.port';

const ref = (
  entryId: string,
  entryNo: string,
  isReversal: boolean,
  reversalOfEntryId: string | null,
  postedAt = '2026-06-29T10:00:00.000Z',
): IpcLedgerEntryRef => ({ entryId, entryNo, isReversal, reversalOfEntryId, postedAt });

describe('buildIpcLinkage', () => {
  it('plain POSTED IPC — single entry, no history, panel hidden', () => {
    const l = buildIpcLinkage([ref('A', 'IPC/2526/0007', false, null)], 'A', false);
    expect(l.hasHistory).toBe(false);
    expect(l.currentEntryNo).toBe('IPC/2526/0007');
    expect(l.originalEntryNo).toBe('IPC/2526/0007');
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0]).toMatchObject({ isCurrent: true, isReversed: false, reversedByEntryNo: null });
  });

  it('CANCELLED IPC — original retained + "reversed by", current stays the original', () => {
    const entries = [
      ref('A', 'IPC/2526/0007', false, null),
      ref('B', 'IPC/2526/0011', true, 'A'),
    ];
    const l = buildIpcLinkage(entries, 'A', true);

    expect(l.hasHistory).toBe(true);
    expect(l.currentEntryNo).toBe('IPC/2526/0007'); // original number retained on cancel
    expect(l.originalEntryNo).toBe('IPC/2526/0007');

    const original = l.entries.find((e) => e.entryId === 'A')!;
    expect(original).toMatchObject({ isCurrent: true, isReversed: true, reversedByEntryNo: 'IPC/2526/0011' });
    const reversal = l.entries.find((e) => e.entryId === 'B')!;
    expect(reversal).toMatchObject({ isReversal: true, reversalOfEntryNo: 'IPC/2526/0007', isCurrent: false });
  });

  it('CORRECTED (reposted) IPC — original superseded → reversal → corrected current', () => {
    const entries = [
      ref('A', 'IPC/2526/0007', false, null, '2026-06-29T10:00:00.000Z'),
      ref('B', 'IPC/2526/0011', true, 'A', '2026-06-30T10:00:00.000Z'),
      ref('C', 'IPC/2526/0012', false, null, '2026-06-30T10:00:00.000Z'),
    ];
    const l = buildIpcLinkage(entries, 'C', false);

    expect(l.hasHistory).toBe(true);
    expect(l.currentEntryNo).toBe('IPC/2526/0012'); // the corrected posting
    expect(l.originalEntryNo).toBe('IPC/2526/0007'); // "original {…} retained"

    expect(l.entries.find((e) => e.entryId === 'A')).toMatchObject({
      isCurrent: false,
      isReversed: true,
      reversedByEntryNo: 'IPC/2526/0011',
    });
    expect(l.entries.find((e) => e.entryId === 'C')).toMatchObject({
      isCurrent: true,
      isReversed: false,
      isReversal: false,
    });
  });

  it('reposted TWICE — original is the earliest, current is the latest corrected', () => {
    const entries = [
      ref('A', 'IPC/2526/0007', false, null),
      ref('B', 'IPC/2526/0011', true, 'A'),
      ref('C', 'IPC/2526/0012', false, null),
      ref('D', 'IPC/2526/0015', true, 'C'),
      ref('E', 'IPC/2526/0016', false, null),
    ];
    const l = buildIpcLinkage(entries, 'E', false);

    expect(l.originalEntryNo).toBe('IPC/2526/0007');
    expect(l.currentEntryNo).toBe('IPC/2526/0016');
    expect(l.entries.find((e) => e.entryId === 'C')).toMatchObject({
      isReversed: true,
      reversedByEntryNo: 'IPC/2526/0015',
      isCurrent: false,
    });
  });
});
