/**
 * REQ (Material Requisition) domain errors (PURE — no Nest). REQ's workflow-specific rejections that
 * LED/MAS/CC do not own: the SUBMITTED-only approve/reject guard, the escalate-by-default approval
 * authority guard, the mandatory reject reason, the no-outstanding-balance close guard, the DRAFT-only
 * edit/delete guard, and the illegal-transition guard. The balance-invariant / over-issue guards belong
 * to the issue (brief 2) but are declared here where the aggregate already carries the balance arithmetic.
 * Stable codes (overview §6); the presentation filter maps them to HTTP status (both files are
 * tsc-enforced exhaustive Records).
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** approve/reject attempted on a requisition not in SUBMITTED (FR-REQ-008/-011). HTTP 409. */
export class RequisitionNotSubmittedError extends DomainError {
  readonly code = DomainErrorCode.REQUISITION_NOT_SUBMITTED;
  constructor(status: string) {
    super(`Only a SUBMITTED requisition can be approved/rejected; this requisition is ${status}`, { status });
  }
}

/** issue attempted on a requisition not in APPROVED/PARTIALLY_ISSUED (FR-REQ-012). HTTP 409. Used by brief 2. */
export class RequisitionNotApprovedError extends DomainError {
  readonly code = DomainErrorCode.REQUISITION_NOT_APPROVED;
  constructor(status: string) {
    super(`Only an APPROVED/PARTIALLY_ISSUED requisition can be issued; this requisition is ${status}`, {
      status,
    });
  }
}

/** The approver's tier/scope does not match the requisition's selected tier (FR-REQ-010/-011). HTTP 403. */
export class ApprovalBeyondAuthorityError extends DomainError {
  readonly code = DomainErrorCode.APPROVAL_BEYOND_AUTHORITY;
  constructor(selectedTier: string) {
    super(
      `The approver holds no authority for a ${selectedTier}-tier requisition; escalate-by-default (overview §10)`,
      { selectedTier },
    );
  }
}

/** A reject without a non-empty reason (FR-REQ-008, edge 7). HTTP 400. */
export class MissingRejectReasonError extends DomainError {
  readonly code = DomainErrorCode.MISSING_REJECT_REASON;
  constructor() {
    super('A reject requires a non-empty reason');
  }
}

/** A manual close on a requisition with no outstanding balance / already ISSUED (FR-REQ-020, edge 15). HTTP 409. */
export class NoOutstandingBalanceError extends DomainError {
  readonly code = DomainErrorCode.NO_OUTSTANDING_BALANCE;
  constructor(status: string) {
    super(`No outstanding balance to close; this requisition is ${status}`, { status });
  }
}

/** An edit/delete attempted on a non-DRAFT requisition (FR-REQ-022, edge 6). HTTP 409. */
export class RequisitionNotDraftError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_POSTED_IMMUTABLE;
  constructor(status: string) {
    super(`Only a DRAFT requisition is editable/deletable; this requisition is ${status}`, { status });
  }
}

/** An illegal lifecycle move (e.g. submit a non-DRAFT, close a DRAFT/REJECTED) (FR-REQ-022). HTTP 409. */
export class InvalidRequisitionTransitionError extends DomainError {
  readonly code = DomainErrorCode.INVALID_REQUISITION_TRANSITION;
  constructor(from: string, action: string) {
    super(`Illegal requisition transition '${action}' from ${from}`, { from, action });
  }
}

/** An issue quantity ≤ 0 or > the line's balance (FR-REQ-012, edge 2). HTTP 400. Used by brief 2 / the aggregate. */
export class IssueExceedsBalanceError extends DomainError {
  readonly code = DomainErrorCode.ISSUE_EXCEEDS_BALANCE;
  constructor(issueQty: string, balance: string) {
    super(`issue quantity ${issueQty} must be in (0, balance ${balance}]`, { issueQty, balance });
  }
}
