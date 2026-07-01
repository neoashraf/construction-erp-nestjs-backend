/**
 * Well-known chart-of-accounts codes SAL resolves its six IPC posting accounts by (SRS §16; design open
 * question — same convention GEN uses). Phase-1: identify these accounts by their standard CoA `code`
 * rather than an explicit MAS flag (MAS owns Account; SAL reads it and adds NO schema). Aligned with the
 * seeded construction CoA and GEN's well-known codes (1200 AR, 1110/1100 bank/cash). If MAS later adds an
 * account-role marker, only the SAL adapter changes.
 *
 * Default rates (retention 10% / advance 15% / VAT 7.5%) are pending-client config, not hard-coded in the
 * aggregate (overview §10 / SRS §15) — held here as the config fallback the IpcConfigAdapter reads.
 */
export const WELL_KNOWN_SALES_ACCOUNTS = {
  accountsReceivableCode: '1200', // AR control (party owes us)
  retentionReceivableCode: '1250', // Retention Receivable (asset)
  mobilizationAdvanceCode: '2300', // Mobilization Advance from customer (liability)
  aitRecoverableCode: '1270', // AIT / TDS Recoverable (asset)
  revenueConstructionCode: '4100', // Revenue — Construction (income)
  outputVatPayableCode: '2200', // Output VAT Payable — Mushak (liability)
} as const;

export const DEFAULT_IPC_RATES = {
  retentionPct: '10',
  advancePct: '15',
  vatPct: '7.5',
} as const;
