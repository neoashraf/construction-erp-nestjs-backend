/**
 * HR domain errors (PURE — no Nest). HR's people-and-attendance rejections that LED/MAS do not own: the
 * daily-labour confirm/re-confirm guards, the not-accruable-mode guard (subcontractor/office never post),
 * the confirmed-row-immutable guard, the office-staff-only policy, the immutable employee code, the
 * reassignment date guard, the biometric reconciliation conflict, and unresolved HR posting accounts /
 * the Labour cost centre. Stable codes (overview §6); both domain-error.ts and the presentation mapping
 * are tsc-enforced exhaustive Records.
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** confirm() attempted on an already-confirmed daily-labour row (edge §12.1). HTTP 409. */
export class AlreadyConfirmedError extends DomainError {
  readonly code = DomainErrorCode.ALREADY_CONFIRMED;
  constructor(attendanceId: string) {
    super(`Attendance row ${attendanceId} is already confirmed; correct via reverse-and-repost`, {
      attendanceId,
    });
  }
}

/** confirm() attempted on a SUBCONTRACTOR/OFFICE row — only DAILY_LABOUR accrues (FR-HR-005). HTTP 409. */
export class NotAccruableModeError extends DomainError {
  readonly code = DomainErrorCode.NOT_ACCRUABLE_MODE;
  constructor(mode: string) {
    super(`Attendance mode ${mode} is not accruable; only DAILY_LABOUR posts a cost accrual`, { mode });
  }
}

/** An edit attempted on an already-confirmed daily-labour row (FR-HR-006). HTTP 409. */
export class AttendanceConfirmedImmutableError extends DomainError {
  readonly code = DomainErrorCode.ATTENDANCE_CONFIRMED_IMMUTABLE;
  constructor(attendanceId: string) {
    super(`Attendance row ${attendanceId} is confirmed and immutable; correct via reverse-and-repost`, {
      attendanceId,
    });
  }
}

/** A reverse/correction attempted on an unconfirmed daily-labour row — nothing to reverse. HTTP 409. */
export class AttendanceNotConfirmedError extends DomainError {
  readonly code = DomainErrorCode.ATTENDANCE_NOT_CONFIRMED;
  constructor(attendanceId: string) {
    super(`Attendance row ${attendanceId} is not confirmed; there is no accrual to reverse`, { attendanceId });
  }
}

/** A daily labourer / subcontractor worker was submitted as an Employee (FR-HR-001, edge §12.14). HTTP 400. */
export class NotOfficeStaffError extends DomainError {
  readonly code = DomainErrorCode.EMPLOYEE_NOT_OFFICE_STAFF;
  constructor(reason: string) {
    super(`Only office staff may be created as an Employee: ${reason}`, { reason });
  }
}

/** employee_code change attempted (immutable once referenced by attendance/salary). HTTP 409. */
export class ImmutableEmployeeCodeError extends DomainError {
  readonly code = DomainErrorCode.IMMUTABLE_EMPLOYEE_CODE;
  constructor() {
    super('employee_code is immutable once the employee is referenced by attendance/salary');
  }
}

/** A reassignment effective date is before the joining date (FR-HR-002). HTTP 400. */
export class EffectiveDateBeforeJoiningError extends DomainError {
  readonly code = DomainErrorCode.EFFECTIVE_DATE_BEFORE_JOINING;
  constructor(effectiveDate: string, joiningDate: string) {
    super(`effectiveDate ${effectiveDate} must be on/after the joining date ${joiningDate}`, {
      effectiveDate,
      joiningDate,
    });
  }
}

/** A biometric import / manual capture conflicts with an existing OFFICE row for the same employee+day. HTTP 409. */
export class DuplicateAttendanceError extends DomainError {
  readonly code = DomainErrorCode.DUPLICATE_ATTENDANCE;
  constructor(employeeId: string, attendanceDate: string) {
    super(
      `An office attendance row already exists for employee ${employeeId} on ${attendanceDate}; resolve the conflict`,
      { employeeId, attendanceDate },
    );
  }
}

/** A required HR posting account (labour cost / labour payable) is not configured in the CoA. HTTP 409. */
export class HrAccountNotConfiguredError extends DomainError {
  readonly code = DomainErrorCode.HR_ACCOUNT_NOT_CONFIGURED;
  constructor(role: string) {
    super(`The ${role} account is not configured in the chart of accounts; configure it before confirming`, {
      role,
    });
  }
}

/** The standard Labour cost centre could not be resolved in MAS (design §8 wiring). HTTP 409. */
export class LabourCostCentreNotConfiguredError extends DomainError {
  readonly code = DomainErrorCode.LABOUR_COST_CENTRE_NOT_CONFIGURED;
  constructor() {
    super('The Labour cost centre is not configured in master data; configure it before confirming');
  }
}
