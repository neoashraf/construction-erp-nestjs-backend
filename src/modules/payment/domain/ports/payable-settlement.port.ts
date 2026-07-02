/**
 * PayableSettlementPort — driving port PAY EXPORTS (#28). The canonical seam other modules read to learn
 * how much of a payable PAY has settled: `applied = Σ(PAY's own posted, non-reversed payment_allocation)`.
 * PUR binds its `BillPaymentReadPort` to this (`appliedToBill` → `appliedTo('PURCHASE_BILL', ...)`); HR reads
 * labour/salary settled through it. Consumers NEVER redefine the Payment entity or re-run PAY's SQL — they
 * ask this port. READ-ONLY: no write path, no ledger touch.
 */
import Decimal from 'decimal.js';
import { PayableType } from '../allocation';

export interface PayableSettlementPort {
  /** Σ amount applied (PAY's own posted, non-reversed payments) to a single payable. 0 when none. */
  appliedTo(payableType: PayableType, payableId: string, companyId: string): Promise<Decimal>;
  /** Batch applied per payable id (one query). Ids with no posted payment are ABSENT from the map. */
  appliedForPayables(payableType: PayableType, ids: string[], companyId: string): Promise<Map<string, Decimal>>;
}

export const PAYABLE_SETTLEMENT_PORT = Symbol('PayableSettlementPort');
