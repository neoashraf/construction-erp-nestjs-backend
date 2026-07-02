/**
 * PUR domain errors (PURE — no Nest). PUR's PO/Bill-specific rejections that LED/INV do not own: the
 * net-payable-non-negative residual guard, the stock-XOR-expense line-type guard, the DRAFT-only lifecycle
 * guards on both the bill and the PO, the PO-not-billable guard, and unresolved purchase posting accounts.
 * Stable codes (overview §6); both domain-error.ts and the presentation mapping are tsc-enforced
 * exhaustive Records (CLAUDE.md checklist — purchase-po-bill-posting brief).
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** net_payable_amount would be < 0 for the given figures (FR-PUR-007, edge case 11). HTTP 400. */
export class NetPayableNegativeError extends DomainError {
  readonly code = DomainErrorCode.NET_PAYABLE_NEGATIVE;
  constructor(netPayable: string) {
    super(
      `net payable amount would be negative (${netPayable}); gross + VAT input must cover TDS + AIT`,
      { netPayable },
    );
  }
}

/** A bill line has both/neither of itemId and expenseAccountId (FR-PUR-005, §11). HTTP 400. */
export class LineTypeError extends DomainError {
  readonly code = DomainErrorCode.LINE_TYPE_INVALID;
  constructor(lineNo: number) {
    super(`Bill line ${lineNo} must be either a stock line (itemId+godownId) or a non-stock line (expenseAccountId), never both/neither`, {
      lineNo,
    });
  }
}

/** An edit/delete/post attempted on a bill that is not DRAFT (FR-PUR-024). HTTP 409. */
export class NotDraftError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_POSTED_IMMUTABLE;
  constructor(status: string) {
    super(`Only a DRAFT Purchase Bill is editable/postable; this bill is ${status}`, { status });
  }
}

/** A cancel/repost attempted on a bill that is not POSTED (FR-PUR-022). HTTP 409. */
export class NotPostedError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_NOT_POSTED;
  constructor(status: string) {
    super(`Only a POSTED Purchase Bill can be cancelled/reposted; this bill is ${status}`, { status });
  }
}

/** A bill/GRN raised against a PO that is not APPROVED/PARTIALLY_* (FR-PUR-002). HTTP 409. */
export class PoNotBillableError extends DomainError {
  readonly code = DomainErrorCode.PO_NOT_BILLABLE;
  constructor(status: string) {
    super(`Purchase Order is not billable; its status is ${status} (must be APPROVED/PARTIALLY_BILLED/PARTIALLY_RECEIVED)`, {
      status,
    });
  }
}

/** An illegal PO status-machine move (edit/approve/cancel out of state, FR-PUR-002/-024). HTTP 409. */
export class InvalidPoTransitionError extends DomainError {
  readonly code = DomainErrorCode.INVALID_PO_TRANSITION;
  constructor(from: string, action: string) {
    super(`Illegal Purchase Order status transition '${action}' from ${from}`, { from, action });
  }
}

/** An edit/delete/post attempted on a GRN that is not DRAFT (FR-PUR-024). HTTP 409. Reuses the
 * canonical VOUCHER_POSTED_IMMUTABLE code (API contract 08-purchase, GRN `…/post` errors) — no new code. */
export class GrnNotDraftError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_POSTED_IMMUTABLE;
  constructor(status: string) {
    super(`Only a DRAFT GRN is editable/postable; this GRN is ${status}`, { status });
  }
}

/** A cancel attempted on a GRN that is not POSTED. HTTP 409. Reuses VOUCHER_NOT_POSTED — no new code. */
export class GrnNotPostedError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_NOT_POSTED;
  constructor(status: string) {
    super(`Only a POSTED GRN can be cancelled; this GRN is ${status}`, { status });
  }
}

/** One of the four purchase posting accounts could not be resolved in the CoA (FR-PUR-009; SRS §16). HTTP 409. */
export class PurchaseAccountNotConfiguredError extends DomainError {
  readonly code = DomainErrorCode.PURCHASE_ACCOUNT_NOT_CONFIGURED;
  constructor(role: string) {
    super(`The ${role} account is not configured in the chart of accounts; configure it before posting a purchase bill`, {
      role,
    });
  }
}
