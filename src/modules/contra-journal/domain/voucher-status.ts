/**
 * VoucherStatus — the GEN voucher lifecycle (design §3). PURE domain. App-checked varchar (mirrors
 * LED's voucher_type treatment; not a Postgres enum). DRAFT is the only editable state; POSTED and
 * CANCELLED are immutable (FR-GEN-014/-018).
 */
export const VOUCHER_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];
