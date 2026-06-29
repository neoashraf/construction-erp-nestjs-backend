/**
 * NumberingSeries domain helpers (PURE — no NestJS/TypeORM). The formatting + increment rules and the
 * per-voucher-type default prefixes. The persistence entity + the locked-counter allocator live in
 * infrastructure; these are the rules they apply (FR-NUM-002, FR-NUM-006, FR-NUM-013).
 */
import { ValidationError } from '../../../common/errors/domain-error';
import { VoucherType } from '../../posting/domain/voucher-type';

export const DEFAULT_PADDING_WIDTH = 4;

/** Default prefixes per voucher type (configurable per series; pending client confirmation, design §10). */
const DEFAULT_PREFIXES: Record<VoucherType, string> = {
  SALES_IPC: 'IPC',
  PURCHASE: 'PUR',
  PAYMENT: 'PV',
  RECEIPT: 'RV',
  CONTRA: 'CV',
  JOURNAL: 'JV',
  STOCK_JOURNAL: 'SJ',
  SALARY: 'SAL',
  DAILY_LABOUR_ACCRUAL: 'DLA',
  OPENING: 'OB',
};

export function defaultPrefixFor(voucherType: VoucherType): string {
  return DEFAULT_PREFIXES[voucherType];
}

/**
 * FY short label from the financial year's start/end calendar years, default format `2526`
 * (design §10, pending NBR confirmation). Derived, never stored on the series (FR-NUM-013).
 */
export function fyShortLabel(startYear: number, endYear: number): string {
  const two = (y: number) => String(y % 100).padStart(2, '0');
  return `${two(startYear)}${two(endYear)}`;
}

/**
 * Format the displayed number: `<prefix>/<fyShortLabel>/<zeroPad(sequence, paddingWidth)>`,
 * e.g. `IPC/2526/0001`. A sequence exceeding the pad width renders at full length, never truncated
 * (FR-NUM-013, SRS Edge Case 8).
 */
export function formatVoucherNumber(
  prefix: string,
  fyLabel: string,
  sequence: number,
  paddingWidth: number,
): string {
  const seq = String(sequence).padStart(paddingWidth, '0');
  return `${prefix}/${fyLabel}/${seq}`;
}

const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_.]*$/;

/** Validate + normalise a prefix: trimmed, non-empty, safe charset, no embedded `/` (SRS §11). */
export function normalizePrefix(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    throw new ValidationError('prefix is required', { field: 'prefix' });
  }
  if (trimmed.includes('/')) {
    throw new ValidationError('prefix must not contain "/"', { field: 'prefix', value: raw });
  }
  if (!PREFIX_PATTERN.test(trimmed)) {
    throw new ValidationError('prefix contains unsafe characters', { field: 'prefix', value: raw });
  }
  return trimmed;
}

/** Validate the padding width (>= 1, FR-NUM-002, SRS §11). */
export function normalizePaddingWidth(raw: number | undefined): number {
  const value = raw ?? DEFAULT_PADDING_WIDTH;
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError('paddingWidth must be an integer >= 1', { field: 'paddingWidth', value: raw });
  }
  return value;
}
