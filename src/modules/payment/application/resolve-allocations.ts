/**
 * resolveAndBindAllocations — shared helper (application): for each allocation on a draft/working payment,
 * look up its payable (PayableLookup), assert it is settleable (posted, same company, something
 * outstanding) and that the allocation does not exceed the payable's remaining outstanding, then bind the
 * resolved control account / dims / party / accrued onto the aggregate. Used by create/post/repost so the
 * cap + binding are identical everywhere (the post/repost calls re-run this INSIDE the tx — authoritative).
 */
import { PaymentVoucher } from '../domain/payment-voucher';
import { PayableLookupPort } from '../domain/ports/payable-lookup.port';
import { AllocationExceedsOutstandingError, PayableNotSettleableError } from '../domain/errors';

export async function resolveAndBindAllocations(
  payment: PaymentVoucher,
  payableLookup: PayableLookupPort,
  companyId: string,
): Promise<void> {
  for (const a of payment.props.allocations) {
    const resolved = await payableLookup.resolve(a.payableType, a.payableId, companyId);
    if (!resolved) {
      throw new PayableNotSettleableError(a.payableType, a.payableId, 'not found for this company');
    }
    if (!resolved.posted) {
      throw new PayableNotSettleableError(a.payableType, a.payableId, 'the payable is not posted');
    }
    if (!resolved.remainingOutstanding.amount.greaterThan(0)) {
      throw new PayableNotSettleableError(a.payableType, a.payableId, 'nothing outstanding to settle');
    }
    if (a.amountAllocated.amount.greaterThan(resolved.remainingOutstanding.amount)) {
      throw new AllocationExceedsOutstandingError(
        a.payableId,
        a.amountAllocated.amount.toFixed(4),
        resolved.remainingOutstanding.amount.toFixed(4),
      );
    }
    payment.applyResolvedPayable(a.lineNo, {
      controlAccountId: resolved.controlAccountId,
      controlAccountType: resolved.controlAccountType,
      isControlAccount: resolved.isControlAccount,
      partyId: resolved.partyId,
      projectId: resolved.projectId,
      costCentreId: resolved.costCentreId,
      purposeId: resolved.purposeId,
      accruedAmount: resolved.accruedAmount,
    });
  }
}
