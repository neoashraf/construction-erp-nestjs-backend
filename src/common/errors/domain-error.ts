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
  // master data (MAS) / shared
  OPTIMISTIC_LOCK_CONFLICT = 'OPTIMISTIC_LOCK_CONFLICT',
  CROSS_COMPANY_REFERENCE = 'CROSS_COMPANY_REFERENCE',
  DUPLICATE_CODE = 'DUPLICATE_CODE',
  DUPLICATE_NAME = 'DUPLICATE_NAME',
  IMMUTABLE_PROJECT_CODE = 'IMMUTABLE_PROJECT_CODE',
  INVALID_STATUS_TRANSITION = 'INVALID_STATUS_TRANSITION',
  REFERENCED_MASTER = 'REFERENCED_MASTER',
  ACCOUNT_TYPE_MISMATCH = 'ACCOUNT_TYPE_MISMATCH',
  ACCOUNT_TYPE_IMMUTABLE = 'ACCOUNT_TYPE_IMMUTABLE',
  BASE_UOM_IMMUTABLE = 'BASE_UOM_IMMUTABLE',
  // cost control (CC)
  CROSS_PROJECT_DIMENSION = 'CROSS_PROJECT_DIMENSION',
  // numbering (NUM)
  SERIES_ALREADY_EXISTS = 'SERIES_ALREADY_EXISTS',
  // ledger / posting (LED)
  LEDGER_IMBALANCE = 'LEDGER_IMBALANCE',
  MISSING_DIMENSION = 'MISSING_DIMENSION',
  APPEND_ONLY_VIOLATION = 'APPEND_ONLY_VIOLATION',
  INVALID_LINE = 'INVALID_LINE',
  PROJECT_CLOSED = 'PROJECT_CLOSED',
  ALREADY_REVERSED = 'ALREADY_REVERSED',
  CANNOT_REVERSE_REVERSAL = 'CANNOT_REVERSE_REVERSAL',
  // period (PER)
  PERIOD_CLOSED = 'PERIOD_CLOSED',
  NO_PERIOD_DEFINED = 'NO_PERIOD_DEFINED',
  PERIODS_ALREADY_EXIST = 'PERIODS_ALREADY_EXIST',
  PERIOD_OVERLAP = 'PERIOD_OVERLAP',
  PERIOD_ALREADY_CLOSED = 'PERIOD_ALREADY_CLOSED',
  PERIOD_ALREADY_OPEN = 'PERIOD_ALREADY_OPEN',
  PERIOD_FY_LOCKED = 'PERIOD_FY_LOCKED',
  NO_PERIODS_FOR_FY = 'NO_PERIODS_FOR_FY',
  FINANCIAL_YEAR_NOT_FOUND = 'FINANCIAL_YEAR_NOT_FOUND',
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

/**
 * An update was attempted against a stale row version (optimistic concurrency, FR-MAS-032).
 * Maps to HTTP 409. Distinct from a generic CONFLICT so clients can reload-and-retry.
 */
export class OptimisticLockConflictError extends DomainError {
  readonly code = DomainErrorCode.OPTIMISTIC_LOCK_CONFLICT;
  constructor(message = 'The record was modified by someone else; reload and retry.', details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** A referenced entity belongs to another company (FR-MAS-028). Maps to HTTP 400. */
export class CrossCompanyReferenceError extends DomainError {
  readonly code = DomainErrorCode.CROSS_COMPANY_REFERENCE;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** A company-unique code already exists (project_code, cost_centre.code, …). HTTP 409. */
export class DuplicateCodeError extends DomainError {
  readonly code = DomainErrorCode.DUPLICATE_CODE;
  constructor(value: string, details?: Record<string, unknown>) {
    super(`Code '${value}' already exists for this company`, { value, ...details });
  }
}

/** A scoped-unique name already exists (purpose per project, godown per project). HTTP 409. */
export class DuplicateNameError extends DomainError {
  readonly code = DomainErrorCode.DUPLICATE_NAME;
  constructor(value: string, details?: Record<string, unknown>) {
    super(`Name '${value}' already exists in this scope`, { value, ...details });
  }
}

/** project_code change attempted after the project is referenced by a transaction (FR-MAS-005). HTTP 409. */
export class ImmutableProjectCodeError extends DomainError {
  readonly code = DomainErrorCode.IMMUTABLE_PROJECT_CODE;
  constructor() {
    super('project_code is immutable once the project is referenced by a transaction');
  }
}

/** An illegal project status-machine move (FR-MAS-006). HTTP 409. */
export class InvalidStatusTransitionError extends DomainError {
  readonly code = DomainErrorCode.INVALID_STATUS_TRANSITION;
  constructor(from: string, action: string) {
    super(`Illegal project status transition '${action}' from ${from}`, { from, action });
  }
}

/** A new godown/budget against a CLOSED project (FR-MAS-006). HTTP 409 (shares PROJECT_CLOSED). */
export class ClosedProjectError extends DomainError {
  readonly code = DomainErrorCode.PROJECT_CLOSED;
  constructor(projectId: string) {
    super(`Project ${projectId} is closed`, { projectId });
  }
}

/** A hard-delete blocked because the row is referenced (FR-MAS-030). HTTP 409. */
export class ReferencedMasterError extends DomainError {
  readonly code = DomainErrorCode.REFERENCED_MASTER;
  constructor(message = 'The record is referenced and cannot be deleted; deactivate instead.') {
    super(message);
  }
}

/** An account's `type` does not equal its group's `type` (FR-MAS-019). HTTP 400. */
export class AccountTypeMismatchError extends DomainError {
  readonly code = DomainErrorCode.ACCOUNT_TYPE_MISMATCH;
  constructor(accountType: string, groupType: string) {
    super(`Account type '${accountType}' must equal its group's type '${groupType}'`, {
      accountType,
      groupType,
    });
  }
}

/** A `type` change attempted on an account that already has ledger postings (FR-MAS-021). HTTP 409. */
export class AccountTypeImmutableError extends DomainError {
  readonly code = DomainErrorCode.ACCOUNT_TYPE_IMMUTABLE;
  constructor() {
    super("An account's type is immutable once it has ledger postings");
  }
}

/** A `base_uom` change attempted after UoM conversions / stock references exist (FR-MAS-034). HTTP 409. */
export class BaseUomImmutableError extends DomainError {
  readonly code = DomainErrorCode.BASE_UOM_IMMUTABLE;
  constructor() {
    super("An item's base_uom is immutable once UoM conversions or stock/transaction references exist");
  }
}

/** A numbering series already exists for the (company, FY, voucher type) triple (FR-NUM-001). HTTP 409. */
export class SeriesAlreadyExistsError extends DomainError {
  readonly code = DomainErrorCode.SERIES_ALREADY_EXISTS;
  constructor(message = 'A numbering series already exists for this company, year and voucher type.', details?: Record<string, unknown>) {
    super(message, details);
  }
}
