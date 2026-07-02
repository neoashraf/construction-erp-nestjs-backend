/**
 * PaymentBackedBillPaymentAdapter (INFRASTRUCTURE) — the real binding of `BillPaymentReadPort` (#28,
 * replaces `ZeroBillPaymentReadAdapter`). Per-bill `appliedToBill` now reads PAY's canonical settlement
 * projection through PAY's exported `PayableSettlementPort` (`appliedTo('PURCHASE_BILL', ...)` = Σ of PAY's
 * own posted, non-reversed allocations to the bill). PUR never redefines the Payment entity nor re-runs PAY's
 * SQL — it asks the port (ADR-0001 #7; same seam style as SAL's `ReceiptAllocationPort`). READ-ONLY.
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BillPaymentReadPort } from '../domain/ports/bill-payment.read.port';
import {
  PAYABLE_SETTLEMENT_PORT,
  PayableSettlementPort,
} from '../../payment/domain/ports/payable-settlement.port';

@Injectable()
export class PaymentBackedBillPaymentAdapter implements BillPaymentReadPort {
  constructor(
    @Inject(PAYABLE_SETTLEMENT_PORT) private readonly settlement: PayableSettlementPort,
  ) {}

  appliedToBill(billId: string, companyId: string): Promise<Decimal> {
    return this.settlement.appliedTo('PURCHASE_BILL', billId, companyId);
  }
}
