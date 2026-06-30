/**
 * LedgerPostingsQuery — the SEAM MAS uses to enforce account-type immutability (FR-MAS-021). The
 * canonical implementation is LED's exported "has-postings" application service; until LED exports it
 * this token is bound to a stand-in adapter that probes `journal_line.account_id` directly
 * (mirroring Project's `isReferencedByTransaction`). When LED ships the service, rebind this token to
 * it in `master-data.module.ts` — no use-case change required.
 *
 * PURE port (domain depends on the interface, not the adapter).
 */
export interface LedgerPostingsQuery {
  /** True if any journal line references this account (its `type` then becomes immutable). */
  hasPostings(accountId: string, companyId: string): Promise<boolean>;
}

export const LEDGER_POSTINGS_QUERY = Symbol('LedgerPostingsQuery');
