/**
 * Well-known chart-of-accounts codes GEN resolves its cash/bank, AR/AP-control, and opening-balance-
 * equity accounts by (SRS §15/§16, design open questions #1/#2). Phase-1 convention: identify these
 * accounts by their standard CoA `code` rather than an explicit MAS flag (MAS owns Account; GEN reads
 * it and does NOT add schema). If MAS later adds an `is_cash_bank` flag / control-account markers, only
 * these adapters change. Aligned with the seeded construction CoA (master-data construction-coa.seed).
 */
export const WELL_KNOWN_ACCOUNTS = {
  /** Cash/bank ASSET accounts for the contra restriction (FR-GEN-003). */
  cashBankCodes: ['1100', '1110'],
  /** Accounts-receivable control account (party owes us). */
  arControlCode: '1200',
  /** Accounts-payable control account (we owe the party). */
  apControlCode: '2100',
  /** Opening-balance-equity (suspense) account — the opening journal's balancing line (FR-GEN-010). */
  openingEquityCode: '3900',
} as const;
