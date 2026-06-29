/**
 * PER domain errors (PURE — no Nest). Each carries a distinct, stable code (overview §6, FR-PER-006).
 * The presentation filter maps the code → HTTP status; the domain never imports Nest exceptions.
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** A ledger write's date falls in a CLOSED period (FR-PER-006). HTTP 409. */
export class PeriodClosedError extends DomainError {
  readonly code = DomainErrorCode.PERIOD_CLOSED;
  constructor(periodId: string, voucherDate: string) {
    super(`Accounting period for ${voucherDate} is closed`, { periodId, voucherDate });
  }
}

/** A ledger write's date falls in no generated period (FR-PER-006). HTTP 409. */
export class NoPeriodDefinedError extends DomainError {
  readonly code = DomainErrorCode.NO_PERIOD_DEFINED;
  constructor(companyId: string, financialYearId: string, voucherDate: string) {
    super(`No accounting period defined for ${voucherDate}`, {
      companyId,
      financialYearId,
      voucherDate,
    });
  }
}

/** A period set already exists for the (company, FY) — generation refused (FR-PER-002). HTTP 409. */
export class PeriodsAlreadyExistError extends DomainError {
  readonly code = DomainErrorCode.PERIODS_ALREADY_EXIST;
  constructor(financialYearId: string) {
    super('A period set already exists for this financial year', { financialYearId });
  }
}

/** close() attempted on a non-OPEN period (FR-PER-008). HTTP 409. */
export class PeriodAlreadyClosedError extends DomainError {
  readonly code = DomainErrorCode.PERIOD_ALREADY_CLOSED;
  constructor(periodId: string) {
    super('Period is not OPEN; close is allowed only from OPEN', { periodId });
  }
}

/** reopen() attempted on a non-CLOSED period (FR-PER-009). HTTP 409. */
export class PeriodAlreadyOpenError extends DomainError {
  readonly code = DomainErrorCode.PERIOD_ALREADY_OPEN;
  constructor(periodId: string) {
    super('Period is not CLOSED; reopen is allowed only from CLOSED', { periodId });
  }
}

/** Reopen blocked because the FY is year-locked (all its periods CLOSED) (FR-PER-010). HTTP 409. */
export class PeriodFyLockedError extends DomainError {
  readonly code = DomainErrorCode.PERIOD_FY_LOCKED;
  constructor(financialYearId: string) {
    super('Financial year is locked (all periods closed); unlock before reopening', {
      financialYearId,
    });
  }
}

/** No period set generated for the FY (FR-PER-010). HTTP 404. */
export class NoPeriodsForFyError extends DomainError {
  readonly code = DomainErrorCode.NO_PERIODS_FOR_FY;
  constructor(financialYearId: string) {
    super('No periods have been generated for this financial year', { financialYearId });
  }
}

/** The referenced financial year does not exist for this company (MAS). HTTP 404. */
export class FinancialYearNotFoundError extends DomainError {
  readonly code = DomainErrorCode.FINANCIAL_YEAR_NOT_FOUND;
  constructor(financialYearId: string) {
    super('Financial year not found', { financialYearId });
  }
}
