/**
 * REC (Receipts) domain errors (PURE — no Nest). REC-specific rejections LED does not own: the settled
 * composition invariant, the reference XOR, the cheque-ref rule, the IPC-linked over-application cap, an
 * IPC-linked receipt against a non-POSTED IPC, and the DRAFT-only lifecycle guards. Distinct, stable codes
 * (overview §6); the presentation filter maps them to HTTP status (both files are tsc-enforced exhaustive
 * Records).
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** `amountSettled != cashReceived + taxDeductedAtSource`, or a non-positive settled amount (FR-REC-019/-020). HTTP 400. */
export class SettledAmountInvalidError extends DomainError {
  readonly code = DomainErrorCode.SETTLED_COMPOSITION_INVALID;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** An IPC-linked receipt's settled amount exceeds the referenced IPC's remaining outstanding (FR-REC-017). HTTP 409. */
export class OverApplicationError extends DomainError {
  readonly code = DomainErrorCode.RECEIPT_EXCEEDS_OUTSTANDING;
  constructor(settled: string, outstanding: string) {
    super(`Settled amount ${settled} exceeds the referenced IPC's remaining outstanding ${outstanding}`, {
      settled,
      outstanding,
    });
  }
}

/** Both or neither of `ipcId` / `generalTargetAccountId` supplied, or a mismatch with `receiptType` (FR-REC-001). HTTP 400. */
export class ReferenceXorError extends DomainError {
  readonly code = DomainErrorCode.REFERENCE_XOR_VIOLATION;
  constructor(message = 'Exactly one of ipcId / generalTargetAccountId is required, matching receiptType') {
    super(message);
  }
}

/** A non-cash payment mode (MFS/BANK_TRANSFER/CHEQUE) without a `chequeTxnRef` (FR-REC-004). HTTP 400. */
export class ChequeRefMissingError extends DomainError {
  readonly code = DomainErrorCode.CHEQUE_REF_REQUIRED;
  constructor(mode: string) {
    super(`chequeTxnRef is required for payment mode ${mode}`, { mode });
  }
}

/** An edit/delete/post attempted on a receipt that is not DRAFT (FR-REC-024). HTTP 409. */
export class NotDraftError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_POSTED_IMMUTABLE;
  constructor(status: string) {
    super(`Only a DRAFT receipt is editable/postable; this receipt is ${status}`, { status });
  }
}

/** A cancel/repost attempted on a receipt that is not POSTED (FR-REC-021). HTTP 409. */
export class NotPostedError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_NOT_POSTED;
  constructor(status: string) {
    super(`Only a POSTED receipt can be cancelled/reposted; this receipt is ${status}`, { status });
  }
}

/** The referenced IPC is not POSTED (FR-REC-002). HTTP 409. */
export class IpcNotPostedError extends DomainError {
  readonly code = DomainErrorCode.IPC_NOT_POSTED;
  constructor(ipcId: string, status: string) {
    super(`IPC ${ipcId} is not POSTED (status ${status}); an IPC-linked receipt requires a POSTED IPC`, {
      ipcId,
      status,
    });
  }
}

/** One of REC's posting accounts (AR / tax-deducted-at-source recoverable) could not be resolved in the CoA. HTTP 409. */
export class ReceiptAccountNotConfiguredError extends DomainError {
  readonly code = DomainErrorCode.RECEIPT_ACCOUNT_NOT_CONFIGURED;
  constructor(role: string) {
    super(`The ${role} account is not configured in the chart of accounts; configure it before posting a receipt`, {
      role,
    });
  }
}

/** The general target account supplied is not an INCOME account or the advance-from-customer liability. HTTP 400. */
export class InvalidGeneralTargetError extends DomainError {
  readonly code = DomainErrorCode.INVALID_GENERAL_TARGET;
  constructor(accountId: string) {
    super(`Account ${accountId} is not a valid general receipt target (must be INCOME or the advance-from-customer liability)`, {
      accountId,
    });
  }
}
