/**
 * SAL (Sales / IPC) domain errors (PURE — no Nest). SAL's IPC-specific rejections that LED does not own:
 * the currently-due-non-negative residual guard, the advance-recovery cap, the certified-positive guard,
 * the duplicate IPC sequence number, the DRAFT-only lifecycle guards, and unresolved sales accounts.
 * Distinct, stable codes (overview §6); the presentation filter maps them to HTTP status (both files are
 * tsc-enforced exhaustive Records).
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** currently_due (residual net AR) would be < 0 for the given figures (FR-SAL-004, edge case 10). HTTP 400. */
export class CurrentlyDueNegativeError extends DomainError {
  readonly code = DomainErrorCode.CURRENTLY_DUE_NEGATIVE;
  constructor(currentlyDue: string) {
    super(
      `currently-due amount would be negative (${currentlyDue}); certified + VAT must cover retention + advance + AIT/TDS`,
      { currentlyDue },
    );
  }
}

/** A client-forced advance recovery exceeds the remaining project advance (FR-SAL-008, edge case 4). HTTP 409. */
export class AdvanceExceededError extends DomainError {
  readonly code = DomainErrorCode.ADVANCE_EXCEEDS_REMAINING;
  constructor(requested: string, remaining: string) {
    super(`advance recovery ${requested} exceeds the remaining project advance ${remaining}`, {
      requested,
      remaining,
    });
  }
}

/** certified_amount is not > 0 (edge case 14). HTTP 400. */
export class CertifiedNotPositiveError extends DomainError {
  readonly code = DomainErrorCode.CERTIFIED_NOT_POSITIVE;
  constructor(certified: string) {
    super(`certified amount must be > 0 (was ${certified}); an IPC certifies positive work`, { certified });
  }
}

/** A second IPC with an existing ipc_seq_no in the same project (FR-SAL-014, edge case 9). HTTP 409. */
export class DuplicateSeqNoError extends DomainError {
  readonly code = DomainErrorCode.DUPLICATE_IPC_SEQ_NO;
  constructor(projectId: string, seqNo: number) {
    super(`IPC sequence number ${seqNo} already exists for project ${projectId}`, { projectId, seqNo });
  }
}

/** An edit/delete/post attempted on an IPC that is not DRAFT (FR-SAL-023). HTTP 409. */
export class NotDraftError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_POSTED_IMMUTABLE;
  constructor(status: string) {
    super(`Only a DRAFT IPC is editable/postable; this IPC is ${status}`, { status });
  }
}

/** A cancel/repost attempted on an IPC that is not POSTED (FR-SAL-021). HTTP 409. */
export class NotPostedError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_NOT_POSTED;
  constructor(status: string) {
    super(`Only a POSTED IPC can be cancelled/reposted; this IPC is ${status}`, { status });
  }
}

/** One of the six sales posting accounts could not be resolved in the CoA (FR-SAL-010; SRS §16). HTTP 409. */
export class SalesAccountNotConfiguredError extends DomainError {
  readonly code = DomainErrorCode.SALES_ACCOUNT_NOT_CONFIGURED;
  constructor(role: string) {
    super(`The ${role} account is not configured in the chart of accounts; configure it before posting an IPC`, {
      role,
    });
  }
}

/** A retention release exceeds the retention currently held (un-released) for the IPC (FR-SAL-019, edge case 7). HTTP 409. */
export class OverReleaseError extends DomainError {
  readonly code = DomainErrorCode.OVER_RELEASE;
  constructor(requested: string, held: string) {
    super(`retention release ${requested} exceeds the retention held ${held} for this IPC`, { requested, held });
  }
}
