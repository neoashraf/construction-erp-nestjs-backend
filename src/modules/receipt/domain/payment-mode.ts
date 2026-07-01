/**
 * PaymentMode / ReceiptType value sets + the cheque-ref rule (PURE — no NestJS/TypeORM). Cash and MFS are
 * normal modes (overview §9); only non-cash modes (MFS, BANK_TRANSFER, CHEQUE) require a
 * `chequeTxnRef` (FR-REC-004). App-checked varchars, not Postgres enums, mirroring LED's voucher-type
 * decision (adding a value is a code change).
 */
export type PaymentMode = 'CASH' | 'MFS' | 'BANK_TRANSFER' | 'CHEQUE';
export const PAYMENT_MODES: readonly PaymentMode[] = ['CASH', 'MFS', 'BANK_TRANSFER', 'CHEQUE'] as const;

export type ReceiptType = 'IPC_LINKED' | 'GENERAL';
export const RECEIPT_TYPES: readonly ReceiptType[] = ['IPC_LINKED', 'GENERAL'] as const;

/** Non-cash modes require a cheque/transaction reference (FR-REC-004). */
export function requiresChequeRef(mode: PaymentMode): boolean {
  return mode === 'MFS' || mode === 'BANK_TRANSFER' || mode === 'CHEQUE';
}
