/**
 * PayableLookupPort — driven port: resolve a payable (purchase bill / daily-labour payable / salary sheet)
 * to its control/liability account, dimensions, party, accrued (labour only), original amount, and CURRENT
 * remaining outstanding. `remainingOutstanding = originalAmount − Σ(PAY's own posted, non-reversed
 * payment_allocation applied to this payable)`. PAY reads the source modules' ORM entities directly (as REC
 * reads SAL); #28 rewires the reverse seam later — until then PAY computes its own applied-total here.
 */
import { Money } from '../../../../common/money';
import { AccountType } from '../../../../core/posting/domain/posting-command';
import { PayableType } from '../allocation';

export interface ResolvedPayable {
  controlAccountId: string;
  controlAccountType: AccountType;
  isControlAccount: boolean;
  partyId: string | null;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  /** The FULL accrued amount — LABOUR_PAYABLE only (drives the accrued-vs-paid true-up); null otherwise. */
  accruedAmount: Money | null;
  originalAmount: Money;
  remainingOutstanding: Money;
  posted: boolean;
}

export interface PayableLookupPort {
  resolve(payableType: PayableType, payableId: string, companyId: string): Promise<ResolvedPayable | null>;
}

export const PAYABLE_LOOKUP_PORT = Symbol('PayableLookupPort');
