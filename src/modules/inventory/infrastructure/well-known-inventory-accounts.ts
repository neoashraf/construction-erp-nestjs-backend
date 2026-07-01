/**
 * Well-known chart-of-accounts code INV resolves its material-expense account by (architectural
 * decision 1; same convention HR/GEN use — see `modules/hr/infrastructure/well-known-hr-accounts.ts`).
 * Phase-1: identify the account by its standard CoA `code` (MAS owns Account; INV reads it and adds NO
 * schema). Aligned with the seeded construction CoA (master-data construction-coa.seed): 5100 Material
 * Expense, 1300 Inventory. The PER-ITEM inventory account is `item.default_account_id` (MAS `Item`), NOT
 * a well-known code — see `inventory-account-resolver.adapter.ts`.
 */
export const WELL_KNOWN_INVENTORY_ACCOUNTS = {
  /** Material Expense — the ISSUE/consumption debit (EXPENSE). */
  materialExpenseCode: '5100',
} as const;
