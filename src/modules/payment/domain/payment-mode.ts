/**
 * PaymentMode value set + the cheque-ref rule (PURE — no NestJS/TypeORM). A cash-out voucher pays a
 * payable via cash, MFS, bank transfer, cheque, or RTGS (SRS §8); only CASH needs no cheque/transaction
 * reference — every non-cash mode requires a `chequeTxnRef`. App-checked varchars (NOT Postgres enums),
 * mirroring LED's voucher-type decision (adding a value is a code change).
 */
export type PaymentMode = 'CASH' | 'MFS' | 'BANK_TRANSFER' | 'CHEQUE' | 'RTGS';
export const PAYMENT_MODES: readonly PaymentMode[] = ['CASH', 'MFS', 'BANK_TRANSFER', 'CHEQUE', 'RTGS'] as const;

/** Every non-cash mode (MFS, BANK_TRANSFER, CHEQUE, RTGS) requires a cheque/transaction reference. */
export function requiresChequeRef(mode: PaymentMode): boolean {
  return mode !== 'CASH';
}
