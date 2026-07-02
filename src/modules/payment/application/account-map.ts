/**
 * buildConcreteAccountMap — turns the resolved company account ids (labour cost + bank charges) into the
 * PaymentAccountMap buildPaymentCommand needs. `controlAccountFor` reads the per-allocation binding the use
 * case already applied from PayableLookup (so the pure builder never does an async lookup).
 */
import { PaymentAccountMap } from '../domain/payment-posting';
import { PaymentAllocation } from '../domain/allocation';
import { ValidationError } from '../../../common/errors/domain-error';

export function buildConcreteAccountMap(map: {
  labourCostAccountId: string;
  bankChargesAccountId: string;
}): PaymentAccountMap {
  return {
    labourCostAccountId: map.labourCostAccountId,
    bankChargesAccountId: map.bankChargesAccountId,
    controlAccountFor(a: PaymentAllocation) {
      if (!a.controlAccountId || !a.controlAccountType || a.isControlAccount === undefined) {
        throw new ValidationError(`Allocation line ${a.lineNo} has no resolved control account`, { lineNo: a.lineNo });
      }
      return { accountId: a.controlAccountId, accountType: a.controlAccountType, isControlAccount: a.isControlAccount };
    },
  };
}
