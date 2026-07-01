/**
 * Well-known chart-of-accounts codes HR resolves its daily-labour accrual accounts by (design §8 wiring;
 * same convention SAL/GEN use). Phase-1: identify these accounts by their standard CoA `code` (MAS owns
 * Account; HR reads it and adds NO schema). Aligned with the seeded construction CoA
 * (master-data construction-coa.seed): 5110 Labour Expense, 2310 Daily-Labour Payable. If MAS later adds
 * an account-role marker, only this HR adapter changes. Salary accounts (gross salary, TDS/PF/advance)
 * are the sibling salary-accrual brief — NOT resolved here.
 */
export const WELL_KNOWN_HR_ACCOUNTS = {
  /** Labour Expense — the daily-labour cost debit (EXPENSE). */
  labourCostCode: '5110',
  /** Daily-Labour Payable — the accrued liability credit (LIABILITY). */
  labourPayableCode: '2310',
} as const;
