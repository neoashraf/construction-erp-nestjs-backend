/**
 * Well-known chart-of-accounts codes REC resolves its two IPC-linked posting accounts by (design open
 * question / SRS §16; same convention SAL/HR/GEN use). Phase-1: identify these accounts by their standard
 * CoA `code` (MAS owns Account; REC reads it and adds NO schema). Reuses SAL's EXACT existing codes so
 * REC's ledger effect is consistent with SAL's chart-of-accounts usage (the architecture brief's guidance):
 *   - 1200 Accounts Receivable (control) — the same AR control SAL credits on the IPC.
 *   - 1220 TDS Recoverable — SAL's existing "Tax-Deducted-at-Source Recoverable" equivalent account.
 * The general receipt's `generalTargetAccountId` is client-supplied directly per the API contract (NOT a
 * well-known-code lookup) — `generalTargetFacts` merely classifies whatever account id the caller sent.
 * If MAS later adds an account-role marker, only this REC adapter changes.
 */
export const WELL_KNOWN_RECEIPT_ACCOUNTS = {
  accountsReceivableCode: '1200', // AR control (party owes us) — same account SAL's IPC credits
  taxDeductedAtSourceRecoverableCode: '1220', // TDS Recoverable (asset)
} as const;
