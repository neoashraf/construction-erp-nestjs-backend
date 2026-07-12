/**
 * IpcLedgerLinkagePort — driven port (LED, read). SAL never redefines the JournalEntry aggregate
 * (ADR-0001 #7); the adapter reads LED's append-only `journal_entry` table directly, filtered to this
 * IPC's ledger footprint (`source_type = 'SalesInvoice'`, `source_id = ipcId`) — the same cross-module
 * read pattern AdvanceBalanceAdapter uses over `journal_line` and ReceiptAllocationAdapter uses over
 * `receipt_allocation`. LED exports no repository/service to SAL.
 *
 * A cancel writes a reversal (inherits the original's source), a repost writes reversal + corrected
 * (both same source), so one source-filtered read returns the WHOLE chain — original(s), reversal(s),
 * and the current corrected posting — from the immutable ledger, the authoritative record of the chain
 * (FR-SAL-022). The raw refs are cross-referenced into presentation linkage by `buildIpcLinkage`.
 */
export interface IpcLedgerEntryRef {
  entryId: string;
  entryNo: string;
  isReversal: boolean;
  /** The original entry this one reverses (LED `reversal_of`); null for a non-reversal posting. */
  reversalOfEntryId: string | null;
  /** ISO-8601 UTC — creation order of the posting within the chain. */
  postedAt: string;
}

export interface IpcLedgerLinkagePort {
  /**
   * Every journal entry posted for this IPC (`source_type = 'SalesInvoice'`, `source_id = ipcId`),
   * oldest → newest. Empty for a DRAFT IPC (no ledger footprint).
   */
  entriesForIpc(ipcId: string, companyId: string): Promise<IpcLedgerEntryRef[]>;
}

export const IPC_LEDGER_LINKAGE_PORT = Symbol('IpcLedgerLinkagePort');
