/**
 * DomainError — the base type the domain throws so presentation can map it to the
 * overview §6 error envelope `{ error: { code, message, details } }` (ADR-0002 §2.3).
 * PURE: the domain throws these and NEVER imports Nest's HttpException.
 */

/**
 * Stable machine-readable error codes. Presentation maps each to an HTTP status.
 * Add codes as modules land; the scaffold ships the cross-cutting ones plus the
 * first ledger/period/numbering codes the kernel will throw.
 */
export enum DomainErrorCode {
  // generic
  VALIDATION = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  FORBIDDEN = 'FORBIDDEN',
  UNAUTHORIZED = 'UNAUTHORIZED',
  // ledger / posting (LED)
  LEDGER_IMBALANCE = 'LEDGER_IMBALANCE',
  MISSING_DIMENSION = 'MISSING_DIMENSION',
  APPEND_ONLY_VIOLATION = 'APPEND_ONLY_VIOLATION',
  // period (PER)
  PERIOD_CLOSED = 'PERIOD_CLOSED',
  // numbering (NUM)
  NUMBERING_EXHAUSTED = 'NUMBERING_EXHAUSTED',
  // tenancy
  TENANT_SCOPE_MISSING = 'TENANT_SCOPE_MISSING',
}

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  protected constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    // restore the prototype chain when targeting ES5/ES6 down-levelled output
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Input/state that the domain rejects (maps to HTTP 400). */
export class ValidationError extends DomainError {
  readonly code = DomainErrorCode.VALIDATION;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** A required entity was not found (maps to HTTP 404). */
export class NotFoundError extends DomainError {
  readonly code = DomainErrorCode.NOT_FOUND;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** A concurrency / uniqueness / state conflict (maps to HTTP 409). */
export class ConflictError extends DomainError {
  readonly code = DomainErrorCode.CONFLICT;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** A query/operation attempted without the required tenant scope (maps to HTTP 400). */
export class TenantScopeMissingError extends DomainError {
  readonly code = DomainErrorCode.TENANT_SCOPE_MISSING;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}
