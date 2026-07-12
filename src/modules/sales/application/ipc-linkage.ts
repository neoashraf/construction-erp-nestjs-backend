/**
 * IPC linkage — the read-side view of an IPC's cancel/repost chain (FR-SAL-022). PURE: cross-references
 * the raw ledger entries (IpcLedgerLinkagePort) into a shape the IPC viewer renders directly — its
 * "Reversed by {entryNo}" / "Corrected as {entryNo} (original {originalEntryNo} retained)" / "Reversal of
 * {entryNo}" labels (screen spec §8; ipc-viewer.md §65-66). The immutable ledger is the source of truth
 * for the chain — SAL stores no linkage columns; this derives it from `source_type='SalesInvoice'`
 * entries at read time.
 *
 *   - CANCELLED IPC → [ original, reversal ]; current = original (its number retained), reversedBy set.
 *   - CORRECTED (reposted) IPC → [ original, reversal, corrected(, …) ]; current = the latest corrected
 *     posting, original retained + marked superseded.
 *   - Plain POSTED IPC → [ original ]; hasHistory=false (the viewer hides the panel).
 */
import { IpcLedgerEntryRef } from '../domain/ports/ipc-ledger-linkage.port';

export interface IpcLinkageEntry {
  entryId: string;
  entryNo: string;
  isReversal: boolean;
  /** A later reversal in this chain reverses this entry. */
  isReversed: boolean;
  /** This entry is the IPC's live posting (`journalEntryId`). */
  isCurrent: boolean;
  /** For a reversal entry: the number of the entry it reverses. */
  reversalOfEntryNo: string | null;
  /** For a reversed entry: the number of the reversal that negated it. */
  reversedByEntryNo: string | null;
  postedAt: string;
}

export interface IpcLinkageDto {
  /** True when a reversal/repost chain exists (cancelled, or more than one posting) — drives the panel. */
  hasHistory: boolean;
  /** The IPC's live posting number (`journalEntryId`); the corrected entry after a repost. */
  currentEntryNo: string | null;
  /** The earliest (retained) posting number — "original {originalEntryNo} retained". */
  originalEntryNo: string | null;
  /** The full chain, oldest → newest. */
  entries: IpcLinkageEntry[];
}

/**
 * Build the linkage view from the source-filtered ledger entries (oldest → newest) and the IPC's current
 * `journalEntryId`. `isCancelled` forces `hasHistory` even in the (impossible-in-practice) single-entry
 * cancelled case, keeping the panel authoritative on status.
 */
export function buildIpcLinkage(
  entries: IpcLedgerEntryRef[],
  currentEntryId: string | null,
  isCancelled: boolean,
): IpcLinkageDto {
  const byId = new Map(entries.map((e) => [e.entryId, e]));
  const reversalByOriginalId = new Map<string, IpcLedgerEntryRef>();
  for (const e of entries) {
    if (e.isReversal && e.reversalOfEntryId) reversalByOriginalId.set(e.reversalOfEntryId, e);
  }

  const items: IpcLinkageEntry[] = entries.map((e) => {
    const reversal = reversalByOriginalId.get(e.entryId) ?? null;
    const reversesOriginal = e.reversalOfEntryId ? byId.get(e.reversalOfEntryId) ?? null : null;
    return {
      entryId: e.entryId,
      entryNo: e.entryNo,
      isReversal: e.isReversal,
      isReversed: reversal !== null,
      isCurrent: currentEntryId !== null && e.entryId === currentEntryId,
      reversalOfEntryNo: reversesOriginal ? reversesOriginal.entryNo : null,
      reversedByEntryNo: reversal ? reversal.entryNo : null,
      postedAt: e.postedAt,
    };
  });

  return {
    hasHistory: isCancelled || entries.length > 1,
    currentEntryNo: items.find((i) => i.isCurrent)?.entryNo ?? null,
    originalEntryNo: items.find((i) => !i.isReversal)?.entryNo ?? null,
    entries: items,
  };
}
