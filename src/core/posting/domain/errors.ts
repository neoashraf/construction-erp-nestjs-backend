/**
 * LED domain errors (PURE — no Nest). The structural ledger invariants + posting-guard rejections.
 * Distinct, stable codes (overview §6); the presentation filter maps them to HTTP status.
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** Σdebit ≠ Σcredit (FR-LED-014). HTTP 400. */
export class LedgerImbalanceError extends DomainError {
  readonly code = DomainErrorCode.LEDGER_IMBALANCE;
  constructor(totalDebit: string, totalCredit: string) {
    super(`Journal entry is unbalanced: Σdebit=${totalDebit} ≠ Σcredit=${totalCredit}`, {
      totalDebit,
      totalCredit,
    });
  }
}

/** A line violates the side invariant: both/neither side non-zero, or a negative amount (FR-LED-008). HTTP 400. */
export class LineSideError extends DomainError {
  readonly code = DomainErrorCode.INVALID_LINE;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** An entry has fewer than two lines (FR-LED-009). HTTP 400. */
export class MinLinesError extends DomainError {
  readonly code = DomainErrorCode.INVALID_LINE;
  constructor(count: number) {
    super(`Journal entry requires at least 2 lines, got ${count}`, { count });
  }
}

/** A line is missing a dimension/party required by the tag matrix (FR-LED-010..012). HTTP 400. */
export class TagMatrixError extends DomainError {
  readonly code = DomainErrorCode.MISSING_DIMENSION;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** A line references a CLOSED project (FR-LED-019). HTTP 409. */
export class ProjectClosedError extends DomainError {
  readonly code = DomainErrorCode.PROJECT_CLOSED;
  constructor(projectId: string) {
    super(`Project ${projectId} is closed; new postings are not allowed`, { projectId });
  }
}

/** The target entry already has a reversal (FR-LED-028; used by the reverse brief). HTTP 409. */
export class AlreadyReversedError extends DomainError {
  readonly code = DomainErrorCode.ALREADY_REVERSED;
  constructor(entryId: string) {
    super(`Journal entry ${entryId} has already been reversed`, { entryId });
  }
}

/** Attempt to reverse a reversal entry (FR-LED-028; used by the reverse brief). HTTP 409. */
export class CannotReverseReversalError extends DomainError {
  readonly code = DomainErrorCode.CANNOT_REVERSE_REVERSAL;
  constructor(entryId: string) {
    super(`Journal entry ${entryId} is a reversal and cannot itself be reversed`, { entryId });
  }
}
