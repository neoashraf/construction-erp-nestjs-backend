/**
 * buildReceiptCommand — the ONLY place the Receipt Dr/Cr mapping lives (PURE — turns a Receipt into a
 * balanced PostingCommand). Mirrors the technical-design §4 worked templates line-for-line and NEVER emits
 * a zero-value line, so a receipt with no tax deducted at source simply has fewer lines while still
 * balancing.
 *
 * §4.1 IPC-linked template:
 *   1. Dr deposit account (Bank/Cash/MFS)      = cashReceived        [dims from IPC, no party]
 *   2. Dr Tax-Deducted-at-Source Recoverable    = taxDeductedAtSource [dims from IPC, no party] (omit if 0)
 *   3. Cr Accounts Receivable (control)         = amountSettled       [dims from IPC, party = IPC customer]
 *
 * §4.2 general template:
 *   1. Dr deposit account (Bank/Cash/MFS)      = amountSettled       [dims from receipt, no party]
 *   2. Cr generalTargetAccount                  = amountSettled       [dims from receipt; party ONLY when
 *                                                                       the target is a control account
 *                                                                       (advance-from-customer liability)]
 *
 * Σdebit = Σcredit by construction (LED re-validates + the deferred DB trigger backstops at commit).
 * `accountType`/`isControlAccount` hints let LED's TagMatrix apply the §5.1 rules without a lookup.
 */
import { Money } from '../../../common/money';
import { PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { Receipt, RECEIPT_SOURCE_TYPE } from './receipt';

/** The resolved receipt posting-account ids (MAS), injected per company. */
export interface ReceiptAccountMap {
  /** Accounts Receivable control account (IPC-linked credit). */
  accountsReceivable: string;
  /** Tax-Deducted-at-Source Recoverable asset (customer-withheld VAT/AIT). */
  taxDeductedAtSourceRecoverable: string;
}

/** Classification of the general receipt's target account, resolved by the caller (MAS). */
export interface GeneralTargetAccountFacts {
  /** True when the target is a control account requiring a party tag (advance-from-customer liability). */
  isControlAccount: boolean;
  accountType: 'INCOME' | 'LIABILITY';
}

export function buildReceiptCommand(
  receipt: Receipt,
  accounts: ReceiptAccountMap,
  postedBy: string,
  generalTarget?: GeneralTargetAccountFacts,
): PostingCommand {
  const p = receipt.props;
  const lines: PostingLine[] = [];

  if (p.receiptType === 'IPC_LINKED') {
    const dims = {
      projectId: p.projectId ?? undefined,
      costCentreId: p.costCentreId,
      purposeId: p.purposeId ?? undefined,
    };
    const party = p.partyId;

    // 1. Dr deposit account — cash actually received.
    if (p.cashReceived.amount.greaterThan(0)) {
      lines.push({
        accountId: p.depositAccountId,
        ...dims,
        debit: p.cashReceived,
        credit: Money.zero(),
        accountType: 'ASSET',
        isControlAccount: false,
      });
    }

    // 2. Dr Tax-Deducted-at-Source Recoverable — omit when zero.
    if (p.taxDeductedAtSource.amount.greaterThan(0)) {
      lines.push({
        accountId: accounts.taxDeductedAtSourceRecoverable,
        ...dims,
        debit: p.taxDeductedAtSource,
        credit: Money.zero(),
        accountType: 'ASSET',
        isControlAccount: false,
      });
    }

    // 3. Cr Accounts Receivable (control) — the full amountSettled, party-tagged to the customer.
    lines.push({
      accountId: accounts.accountsReceivable,
      ...dims,
      partyId: party,
      debit: Money.zero(),
      credit: p.amountSettled,
      accountType: 'ASSET',
      isControlAccount: true,
    });
  } else {
    // GENERAL: project OPTIONAL, cost_centre + purpose required.
    const dims = {
      projectId: p.projectId ?? undefined,
      costCentreId: p.costCentreId,
      purposeId: p.purposeId ?? undefined,
    };

    // 1. Dr deposit account — the full amountSettled (no tax-deducted-at-source on a general receipt).
    lines.push({
      accountId: p.depositAccountId,
      ...dims,
      debit: p.amountSettled,
      credit: Money.zero(),
      accountType: 'ASSET',
      isControlAccount: false,
    });

    // 2. Cr generalTargetAccount — income (no party) or the advance-from-customer liability (party-tagged).
    const isControl = generalTarget?.isControlAccount ?? false;
    lines.push({
      accountId: p.generalTargetAccountId as string,
      ...dims,
      ...(isControl ? { partyId: p.partyId } : {}),
      debit: Money.zero(),
      credit: p.amountSettled,
      accountType: generalTarget?.accountType ?? 'INCOME',
      isControlAccount: isControl,
    });
  }

  return {
    companyId: p.companyId,
    financialYearId: p.financialYearId,
    voucherType: 'RECEIPT',
    voucherDate: p.receiptDate,
    sourceType: RECEIPT_SOURCE_TYPE,
    sourceId: receipt.id,
    postedBy,
    narration: p.narration ?? undefined,
    lines,
  };
}
