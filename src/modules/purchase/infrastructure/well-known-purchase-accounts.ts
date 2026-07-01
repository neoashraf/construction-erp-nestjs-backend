/**
 * Well-known chart-of-accounts codes PUR resolves its four non-inventory posting accounts by
 * (architectural decision 3 — mirrors HR's/GEN's exact convention). Phase-1: identify these accounts by
 * their standard CoA `code` (MAS owns Account; PUR reads it and adds NO schema). Aligned with the seeded
 * construction CoA (master-data construction-coa.seed): 1230 VAT Input (Recoverable), 2100 Accounts
 * Payable (the SAME control account GEN's contra module already references as `apControlCode` — correct,
 * same real-world AP account, no conflict), 2210 TDS Payable, 2220 AIT Payable. The fifth account (per-item
 * inventory) is NOT resolved here — it delegates to INV's `InventoryAccountResolver` (decision 2).
 *
 * Default rates (VAT input 7.5% / TDS 5% / AIT 2%) are pending-client config, not hard-coded in the
 * aggregate (per the design §4.1 worked example and the SAL/HR "defaults until confirmed" convention) —
 * held here as the config fallback `PurchaseConfigAdapter` reads.
 */
export const WELL_KNOWN_PURCHASE_ACCOUNTS = {
  vatInputRecoverableCode: '1230', // VAT Input (Recoverable) — asset
  accountsPayableCode: '2100', // Accounts Payable (control) — liability
  tdsPayableCode: '2210', // TDS Payable — liability
  aitPayableCode: '2220', // AIT Payable — liability
} as const;

export const DEFAULT_PURCHASE_TAX_RATES = {
  vatInputPct: '7.5',
  tdsPct: '5',
  aitPct: '2',
} as const;
