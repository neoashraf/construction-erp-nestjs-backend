/**
 * PAY (Payments) domain errors (PURE — no Nest). PAY-specific rejections LED does not own: over-allocation
 * of the total, the cheque-ref rule, a non-settleable payable, an allocation exceeding a payable's
 * outstanding, the defense-in-depth "settlement account must not be an expense" guard, and the missing
 * payment posting-account. The DRAFT/POSTED lifecycle guards reuse the shared VOUCHER_* codes. Distinct,
 * stable codes (overview §6); the presentation filter maps them to HTTP status (both files are
 * tsc-enforced exhaustive Records).
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** Σ amountAllocated exceeds the payment's total paymentAmount. HTTP 409. */
export class OverAllocationError extends DomainError {
  readonly code = DomainErrorCode.PAYMENT_OVER_ALLOCATION;
  constructor(allocated: string, total: string) {
    super(`Allocated total ${allocated} exceeds the payment amount ${total}`, { allocated, total });
  }
}

/** A non-cash payment mode (MFS/BANK_TRANSFER/CHEQUE/RTGS) without a `chequeTxnRef`. HTTP 400. */
export class ChequeRefMissingError extends DomainError {
  readonly code = DomainErrorCode.CHEQUE_REF_REQUIRED;
  constructor(mode: string) {
    super(`chequeTxnRef is required for payment mode ${mode}`, { mode });
  }
}

/** An edit/delete/post attempted on a payment that is not DRAFT. HTTP 409. */
export class NotDraftError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_POSTED_IMMUTABLE;
  constructor(status: string) {
    super(`Only a DRAFT payment is editable/postable; this payment is ${status}`, { status });
  }
}

/** A cancel/repost attempted on a payment that is not POSTED. HTTP 409. */
export class NotPostedError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_NOT_POSTED;
  constructor(status: string) {
    super(`Only a POSTED payment can be cancelled/reposted; this payment is ${status}`, { status });
  }
}

/** The referenced payable is not settleable (not found / not posted / nothing outstanding). HTTP 409. */
export class PayableNotSettleableError extends DomainError {
  readonly code = DomainErrorCode.PAYABLE_NOT_SETTLEABLE;
  constructor(payableType: string, payableId: string, reason: string) {
    super(`Payable ${payableType} ${payableId} is not settleable: ${reason}`, { payableType, payableId, reason });
  }
}

/** An allocation exceeds the referenced payable's remaining outstanding. HTTP 409. */
export class AllocationExceedsOutstandingError extends DomainError {
  readonly code = DomainErrorCode.ALLOCATION_EXCEEDS_OUTSTANDING;
  constructor(payableId: string, allocated: string, outstanding: string) {
    super(`Allocation ${allocated} to payable ${payableId} exceeds its remaining outstanding ${outstanding}`, {
      payableId,
      allocated,
      outstanding,
    });
  }
}

/**
 * Defense-in-depth (AC4): a resolved settlement/control account classified EXPENSE — a payment must NEVER
 * debit an expense to settle a payable (CLAUDE.md load-bearing rule). HTTP 409.
 */
export class SettlementAccountIsExpenseError extends DomainError {
  readonly code = DomainErrorCode.SETTLEMENT_ACCOUNT_IS_EXPENSE;
  constructor(accountId: string) {
    super(
      `Settlement account ${accountId} is an EXPENSE account; a payment settles a payable/liability and must never debit an expense`,
      { accountId },
    );
  }
}

/** One of PAY's posting accounts (labour cost / bank charges / a payable control) is not configured. HTTP 409. */
export class PaymentAccountNotConfiguredError extends DomainError {
  readonly code = DomainErrorCode.PAYMENT_ACCOUNT_NOT_CONFIGURED;
  constructor(role: string) {
    super(`The ${role} account is not configured in the chart of accounts; configure it before posting a payment`, {
      role,
    });
  }
}
