/**
 * PaymentAllocation (PURE) — one settled payable on a Payment voucher. The payable's control/liability
 * account + its dimensions/party/accrued are RESOLVED server-side by PayableLookup and bound onto the
 * allocation by the use case before the posting command is built (the `controlAccount*`/`isControlAccount`
 * fields are the resolved binding). PAY carries the cash-out side; it never re-expenses a settlement.
 */
import { Money } from '../../../common/money';
import { AccountType } from '../../../core/posting/domain/posting-command';

export type PayableType = 'PURCHASE_BILL' | 'LABOUR_PAYABLE' | 'SALARY';
export const PAYABLE_TYPES: readonly PayableType[] = ['PURCHASE_BILL', 'LABOUR_PAYABLE', 'SALARY'] as const;

export interface PaymentAllocation {
  lineNo: number;
  payableType: PayableType;
  payableId: string;
  amountAllocated: Money;
  /** The FULL accrued liability of the payable — LABOUR_PAYABLE only (drives the accrued-vs-paid true-up). */
  accruedAmount: Money | null;
  partyId: string | null;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  // Resolved binding (set by the use case from PayableLookup before the command is built):
  controlAccountId?: string;
  controlAccountType?: AccountType;
  isControlAccount?: boolean;
}
