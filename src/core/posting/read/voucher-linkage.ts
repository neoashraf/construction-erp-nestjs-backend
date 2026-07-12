/**
 * Voucher linkage (LED read kernel) — the shared cancel/repost chain view for ANY source voucher that
 * posts through PostingService (SAL IPC pioneered this as `ipc-linkage`; REC receipts and PAY payments
 * reuse it here). A cancel writes a reversal (which inherits the original's `source_type`/`source_id`
 * via `JournalEntry.reverse`), a repost writes reversal + corrected — so ONE source-filtered read over the
 * immutable `journal_entry` returns the WHOLE chain. No voucher module stores linkage columns; it is
 * derived read-only from the ledger, the authoritative record (append-only; ADR-0001).
 *
 * The DTO shape is identical to SAL's `IpcLinkageDto` so every voucher viewer (IPC / receipt / payment)
 * renders the same `linkage` object and composes the same labels: "Reversed by {reversedByEntryNo}",
 * "Reversal of {reversalOfEntryNo}", "Corrected as {currentEntryNo} (original {originalEntryNo} retained)".
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';

export interface VoucherLedgerEntryRef {
  entryId: string;
  entryNo: string;
  isReversal: boolean;
  /** The original entry this one reverses (LED `reversal_of`); null for a non-reversal posting. */
  reversalOfEntryId: string | null;
  /** ISO-8601 UTC — creation order of the posting within the chain. */
  postedAt: string;
}

export interface VoucherLinkageEntry {
  entryId: string;
  entryNo: string;
  isReversal: boolean;
  /** A later reversal in this chain reverses this entry. */
  isReversed: boolean;
  /** This entry is the voucher's live posting (`journalEntryId`). */
  isCurrent: boolean;
  /** For a reversal entry: the number of the entry it reverses. */
  reversalOfEntryNo: string | null;
  /** For a reversed entry: the number of the reversal that negated it. */
  reversedByEntryNo: string | null;
  postedAt: string;
}

export interface VoucherLinkageDto {
  /** True when a reversal/repost chain exists (cancelled, or more than one posting) — drives the panel. */
  hasHistory: boolean;
  /** The voucher's live posting number (`journalEntryId`); the corrected entry after a repost. */
  currentEntryNo: string | null;
  /** The earliest (retained) posting number — "original {originalEntryNo} retained". */
  originalEntryNo: string | null;
  /** The full chain, oldest → newest. */
  entries: VoucherLinkageEntry[];
}

/**
 * Cross-reference the source-filtered ledger entries (oldest → newest) + the voucher's current
 * `journalEntryId` into the presentation linkage. Pure. `isCancelled` forces `hasHistory` on a cancelled
 * voucher regardless of chain length, keeping the panel authoritative on status.
 */
export function buildVoucherLinkage(
  entries: VoucherLedgerEntryRef[],
  currentEntryId: string | null,
  isCancelled: boolean,
): VoucherLinkageDto {
  const byId = new Map(entries.map((e) => [e.entryId, e]));
  const reversalByOriginalId = new Map<string, VoucherLedgerEntryRef>();
  for (const e of entries) {
    if (e.isReversal && e.reversalOfEntryId) reversalByOriginalId.set(e.reversalOfEntryId, e);
  }

  const items: VoucherLinkageEntry[] = entries.map((e) => {
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

/**
 * VoucherLinkageReader — reads LED's append-only `journal_entry` by source and assembles the linkage view.
 * Provided + exported by PostingModule (LED owns `journal_entry`); voucher read services inject it rather
 * than reaching into the ledger themselves. Ordered by `created_at` then `entry_no`: a repost writes its
 * reversal + corrected in ONE transaction (identical `now()`), so `entry_no` — allocated gaplessly in
 * creation order — is the tie-breaker that keeps the chain in true posting order.
 */
@Injectable()
export class VoucherLinkageReader {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async entriesForSource(
    companyId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<VoucherLedgerEntryRef[]> {
    const rows: Array<{
      id: string;
      entry_no: string;
      is_reversal: boolean;
      reversal_of: string | null;
      created_at: Date;
    }> = await getManager(this.dataSource).query(
      `SELECT id, entry_no, is_reversal, reversal_of, created_at
         FROM journal_entry
        WHERE company_id = $1 AND source_type = $2 AND source_id = $3
        ORDER BY created_at ASC, entry_no ASC`,
      [companyId, sourceType, sourceId],
    );
    return rows.map((r) => ({
      entryId: r.id,
      entryNo: r.entry_no,
      isReversal: r.is_reversal,
      reversalOfEntryId: r.reversal_of,
      postedAt: new Date(r.created_at).toISOString(),
    }));
  }

  /**
   * The linkage view for one voucher. `null` for a DRAFT voucher (no `journalEntryId`, no ledger
   * footprint) or one with no ledger entries yet.
   */
  async forVoucher(
    companyId: string,
    sourceType: string,
    sourceId: string,
    currentJournalEntryId: string | null,
    isCancelled: boolean,
  ): Promise<VoucherLinkageDto | null> {
    if (!currentJournalEntryId) return null;
    const entries = await this.entriesForSource(companyId, sourceType, sourceId);
    if (entries.length === 0) return null;
    return buildVoucherLinkage(entries, currentJournalEntryId, isCancelled);
  }
}
