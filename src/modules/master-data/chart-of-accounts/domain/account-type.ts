/**
 * AccountType — the five canonical account classes (MAS, FR-MAS-017/019). PURE domain. App-checked
 * string set (mirrored by the `chk_*_type` CHECK constraints), shared by AccountGroup and Account.
 * P&L = INCOME/EXPENSE; balance sheet = ASSET/LIABILITY/EQUITY (SRS §6).
 */
import { ValidationError } from '../../../../common/errors/domain-error';

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export function assertAccountType(value: string): AccountType {
  if (!ACCOUNT_TYPES.includes(value as AccountType)) {
    throw new ValidationError(`Invalid account type '${value}'`, { value, allowed: ACCOUNT_TYPES });
  }
  return value as AccountType;
}
