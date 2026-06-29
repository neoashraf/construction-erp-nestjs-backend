/**
 * VoucherType — the canonical, LED-owned value set (single source of truth; skill §5.2, ADR-0001 #9).
 * 10 DISTINCT types, each with its own numbering series + tag-matrix row. An app-level checked varchar
 * (NOT a Postgres enum) so adding a type is code-only. OPENING and DAILY_LABOUR_ACCRUAL are first-class
 * types, not sub-types of JOURNAL. NUM/PER and every voucher module reference this; only LED extends it.
 *
 * Declared here under `core/posting/domain` (LED's home) because LED owns it; NUM is the first module
 * to need it and merely references it.
 */
export const VOUCHER_TYPES = [
  'SALES_IPC',
  'PURCHASE',
  'PAYMENT',
  'RECEIPT',
  'CONTRA',
  'JOURNAL',
  'STOCK_JOURNAL',
  'SALARY',
  'DAILY_LABOUR_ACCRUAL',
  'OPENING',
] as const;

export type VoucherType = (typeof VOUCHER_TYPES)[number];

export function isVoucherType(value: string): value is VoucherType {
  return (VOUCHER_TYPES as readonly string[]).includes(value);
}
