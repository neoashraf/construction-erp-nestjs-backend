/**
 * ZeroBillPaymentReadAdapter (INFRASTRUCTURE) — the Phase-1 binding of `BillPaymentReadPort`. PAY has not
 * shipped, so NOTHING has been applied to any bill yet: `appliedToBill` returns exactly 0, making every
 * POSTED bill's `outstandingAmount = netPayableAmount` (FR-PUR-020's correct starting state). The
 * **`payment-bill-allocation` brief (#28)** rebinds `BILL_PAYMENT_READ_PORT` in purchase.module.ts to an
 * adapter that reads PAY's real per-bill allocation rows/view — deliberately NO SQL against a table that
 * does not exist yet (mirrors how REC's `receipt_allocation` seam was handled for SAL).
 */
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BillPaymentReadPort } from '../domain/ports/bill-payment.read.port';

@Injectable()
export class ZeroBillPaymentReadAdapter implements BillPaymentReadPort {
  async appliedToBill(_billId: string, _companyId: string): Promise<Decimal> {
    void _billId;
    void _companyId;
    return new Decimal(0);
  }
}
