/**
 * receipt_allocation — the seam to SAL (design §2.5/§5.3, brief #24). REC is the PRODUCER of this
 * projection; SAL's `ReceiptAllocationPort` (brief #21, sales-ipc-retention-release) is the CONSUMER,
 * reading it in-process (never over HTTP). The physical object is a database VIEW created in this
 * module's migration (NOT a table in Phase 1 — §2.5 decision (a)):
 *
 *   CREATE VIEW receipt_allocation AS
 *   SELECT r.ipc_id, r.id AS receipt_id, r.amount_settled AS amount_applied
 *   FROM   receipt r
 *   JOIN   journal_entry je ON je.id = r.journal_entry_id
 *   WHERE  r.receipt_type = 'IPC_LINKED'
 *     AND  r.status = 'POSTED'
 *     AND  NOT EXISTS (SELECT 1 FROM journal_entry rev WHERE rev.reversal_of = je.id);
 *
 * Selecting posted, non-reversed IPC-linked receipts only — a cancelled (reversed) receipt automatically
 * drops out, so the referenced IPC's outstanding restores with nothing to unwind (FR-REC-022). Columns are
 * exactly `(ipc_id, receipt_id, amount_applied)` per the design's forward-compatible shape (a real
 * `receipt_allocation` table with the same columns is introduced only if multi-IPC allocation ships —
 * design §10). This file is documentation + the typed row shape SAL's adapter maps to; it holds no
 * runtime code because a bare SELECT over a plain view needs no repository abstraction on REC's side.
 */
export interface ReceiptAllocationRow {
  ipcId: string;
  receiptId: string;
  amountApplied: string; // numeric(18,4) as a string, per the platform's money-as-string JSON convention
}

export const RECEIPT_ALLOCATION_VIEW = 'receipt_allocation';
