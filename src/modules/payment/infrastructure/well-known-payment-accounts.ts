/**
 * Well-known chart-of-accounts codes PAY resolves its posting accounts by (same convention SAL/HR/REC use).
 * Phase-1: identify these accounts by their standard CoA `code` (MAS owns Account; PAY reads it and adds NO
 * schema). If MAS later adds an account-role marker, only the PAY adapters change.
 *   - 2100 Accounts Payable (control)     — the supplier-bill settlement debit (party-tagged).
 *   - 2310 Daily-Labour Payable            — the daily-labour aggregate liability (no party).
 *   - 2300 Salary Payable                  — the salary-sheet net liability (no party).
 *   - 5110 Labour Expense (labour cost)    — the daily-labour accrued-vs-paid true-up line.
 *   - 6200 Bank Charges (expense)          — the optional bank-charge line.
 */
export const WELL_KNOWN_PAYMENT_ACCOUNTS = {
  accountsPayableCode: '2100',
  dailyLabourPayableCode: '2310',
  salaryPayableCode: '2300',
  labourCostCode: '5110',
  bankChargesCode: '6200',
} as const;
