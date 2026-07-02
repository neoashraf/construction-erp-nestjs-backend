/**
 * BillPaymentReadPort — driven port (PAY, read). PUR never redefines the Payment entity (ADR-0001 #7);
 * per-bill `paidAmount`/`outstandingAmount` are queries over PAY's applied payments (FR-PUR-020), reached
 * through this seam — mirroring SAL's `ReceiptAllocationPort` (REC) exactly.
 *
 * PAY has NOT shipped as of this brief (purchase-grn-matching) — there is no `payment_allocation` table to
 * query, so the Phase-1 binding is `ZeroBillPaymentReadAdapter` (returns 0 = "nothing applied yet", the
 * exact starting state PAY's allocations will reduce). The **`payment-bill-allocation` brief (#28)** is
 * the one that rebinds this port to an adapter reading PAY's real allocation rows/view — no SQL against a
 * nonexistent table is guessed here.
 */
import Decimal from 'decimal.js';

export interface BillPaymentReadPort {
  /** Σ(amount applied) of payments referencing this specific bill (PAY) — 0 until PAY ships. */
  appliedToBill(billId: string, companyId: string): Promise<Decimal>;
}

export const BILL_PAYMENT_READ_PORT = Symbol('BillPaymentReadPort');
