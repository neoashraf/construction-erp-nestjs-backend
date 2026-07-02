/**
 * PayableSettlementAdapter (INFRASTRUCTURE) — binds the exported `PayableSettlementPort` by delegating to
 * `PaymentAllocationReadModel` (the one projection). A thin delegate: the SQL lives in the read model, this
 * adapter only satisfies the port contract PUR/HR consume so PAY exports a stable seam, not its internals.
 */
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PayableType } from '../domain/allocation';
import { PayableSettlementPort } from '../domain/ports/payable-settlement.port';
import { PaymentAllocationReadModel } from './payment-allocation.read-model';

@Injectable()
export class PayableSettlementAdapter implements PayableSettlementPort {
  constructor(private readonly readModel: PaymentAllocationReadModel) {}

  appliedTo(payableType: PayableType, payableId: string, companyId: string): Promise<Decimal> {
    return this.readModel.appliedTo(payableType, payableId, companyId);
  }

  appliedForPayables(
    payableType: PayableType,
    ids: string[],
    companyId: string,
  ): Promise<Map<string, Decimal>> {
    return this.readModel.appliedForPayables(payableType, ids, companyId);
  }
}
