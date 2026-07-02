/**
 * buildPaymentCommand — the ONLY place the Payment Dr/Cr mapping lives (PURE — turns a PaymentVoucher into
 * a balanced PostingCommand). A payment DEBITS each payable's control/liability account and CREDITS the
 * residual cash (bank/cash/MFS). It NEVER debits an expense to settle (AC4 — the SettlementAccountIsExpense
 * guard). The ONLY P&L lines are (a) bank charges (expense) and (b) the daily-labour accrued-vs-paid
 * true-up (Dr/Cr Labour Cost). Σdebit = Σcredit by construction — the cash credit is the residual.
 *
 * Per allocation:
 *   - settlement DEBIT the control account (party-tagged only when it is a control account); NO dims.
 *   - LABOUR_PAYABLE true-up (accrued != paid): the settlement debit clears the FULL accrued; a Labour-Cost
 *     line tagged project+cost_centre+purpose carries the difference (Cr when paid < accrued, Dr when
 *     paid > accrued); the cash residual for this allocation is the CASH actually paid (= amountAllocated).
 *   - otherwise the cash residual for this allocation is amountAllocated.
 * Then an optional bank-charge DEBIT (dims), and the residual cash CREDIT (no dims, no party).
 */
import { Money } from '../../../common/money';
import { AccountType, PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { PaymentAllocation } from './allocation';
import { SettlementAccountIsExpenseError } from './errors';
import { PAYMENT_SOURCE_TYPE, PaymentVoucher } from './payment-voucher';

/** The resolved posting-account facts the caller supplies per company. */
export interface PaymentAccountMap {
  /** The bound control/liability account for an allocation (resolved via PayableLookup). */
  controlAccountFor(a: PaymentAllocation): { accountId: string; accountType: AccountType; isControlAccount: boolean };
  /** Labour cost account (CoA '5110') — the daily-labour accrued-vs-paid true-up line. */
  labourCostAccountId: string;
  /** Bank charges expense account (CoA '6200'). */
  bankChargesAccountId: string;
}

export function buildPaymentCommand(p: PaymentVoucher, accounts: PaymentAccountMap, postedBy: string): PostingCommand {
  const props = p.props;
  const lines: PostingLine[] = [];
  let cashOut = Money.zero();

  for (const a of props.allocations) {
    const ctrl = accounts.controlAccountFor(a);
    // AC4 — a payment must never debit an expense account to settle a payable.
    if (ctrl.accountType === 'EXPENSE') {
      throw new SettlementAccountIsExpenseError(ctrl.accountId);
    }

    const party = ctrl.isControlAccount ? (a.partyId ?? undefined) : undefined;
    const isLabourTrueUp =
      a.payableType === 'LABOUR_PAYABLE' && a.accruedAmount !== null && !a.amountAllocated.equals(a.accruedAmount);

    if (isLabourTrueUp) {
      const accrued = a.accruedAmount as Money;
      const paid = a.amountAllocated;

      // Settlement debit clears the FULL accrued liability.
      lines.push({
        accountId: ctrl.accountId,
        debit: accrued,
        credit: Money.zero(),
        accountType: ctrl.accountType,
        isControlAccount: ctrl.isControlAccount,
        partyId: party,
      });

      const dims = {
        projectId: a.projectId ?? undefined,
        costCentreId: a.costCentreId ?? undefined,
        purposeId: a.purposeId ?? undefined,
      };
      if (paid.amount.lessThan(accrued.amount)) {
        // Paid less than accrued — cost down: Cr Labour Cost (accrued - paid).
        lines.push({
          accountId: accounts.labourCostAccountId,
          ...dims,
          debit: Money.zero(),
          credit: accrued.minus(paid),
          accountType: 'EXPENSE',
          isControlAccount: false,
        });
      } else {
        // Paid more than accrued — cost up: Dr Labour Cost (paid - accrued).
        lines.push({
          accountId: accounts.labourCostAccountId,
          ...dims,
          debit: paid.minus(accrued),
          credit: Money.zero(),
          accountType: 'EXPENSE',
          isControlAccount: false,
        });
      }
      // Cash actually paid for this allocation.
      cashOut = cashOut.plus(paid);
    } else {
      // Plain settlement: Dr control = amountAllocated; cash out = amountAllocated.
      lines.push({
        accountId: ctrl.accountId,
        debit: a.amountAllocated,
        credit: Money.zero(),
        accountType: ctrl.accountType,
        isControlAccount: ctrl.isControlAccount,
        partyId: party,
      });
      cashOut = cashOut.plus(a.amountAllocated);
    }
  }

  // Bank charge (optional) — an expense line carrying project + cost_centre + purpose.
  if (props.bankChargesAmount.amount.greaterThan(0)) {
    lines.push({
      accountId: accounts.bankChargesAccountId,
      projectId: props.bankChargesProjectId ?? undefined,
      costCentreId: props.bankChargesCostCentreId ?? undefined,
      purposeId: props.bankChargesPurposeId ?? undefined,
      debit: props.bankChargesAmount,
      credit: Money.zero(),
      accountType: 'EXPENSE',
      isControlAccount: false,
    });
    cashOut = cashOut.plus(props.bankChargesAmount);
  }

  // Residual cash credit — bank/cash/MFS; no dims, no party.
  lines.push({
    accountId: props.paymentAccountId,
    debit: Money.zero(),
    credit: cashOut,
    accountType: 'ASSET',
    isControlAccount: false,
  });

  return {
    companyId: props.companyId,
    financialYearId: props.financialYearId,
    voucherType: 'PAYMENT',
    voucherDate: props.paymentDate,
    sourceType: PAYMENT_SOURCE_TYPE,
    sourceId: p.id,
    postedBy,
    narration: props.narration ?? undefined,
    lines,
  };
}
