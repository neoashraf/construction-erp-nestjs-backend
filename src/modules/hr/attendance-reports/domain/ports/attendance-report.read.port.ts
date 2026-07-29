/**
 * The four reads the attendance reports need, behind one port so `AttendanceReportService` stays pure
 * business logic and is unit-testable with a fake (REPORTS_MODULE_GUIDE §6.2 `queries/settings.js` +
 * `queries/holidays.js` + the two loaders in `queries/reports.js`, collapsed into one port here).
 * Every method is companyId-scoped — an unscoped read is a cross-tenant leak (ADR-0002 F3).
 */
import { EmployeeIdentity } from '../attendance-report.model';
import { GovernmentHoliday, LateThreshold } from '../attendance-rules';

/**
 * One employee's resolved attendance day.
 *
 * Sourced from `attendance_record` (mode `OFFICE`), not from raw punches — see the adapter's header
 * for why the ordering matters. The name is historical; it is a DAY, and since a day can carry a
 * status with no times at all, `dayStatus` is the field that makes such a day representable.
 */
export interface DailyPunchRow {
  /** `employee.id` — the join key; the report exposes `userId` (= `employee_code`) instead. */
  employeeId: string;
  attendanceDate: string;
  /** `'YYYY-MM-DD HH:mm:ss'`, or null when that day has no check-in. */
  checkInAt: string | null;
  checkOutAt: string | null;
  punchCount: number;
  /**
   * `PRESENT` · `PAID_LEAVE` · `UNPAID_LEAVE` · `ABSENT`, or null on a row that carries none.
   *
   * A leave day has NO times, so without this the report can only infer "no check-in ⇒ Absent" and
   * renders a day payroll pays as an absence — against the very register HR checks a payslip with.
   */
  dayStatus: string | null;
}

/**
 * An employee-day that has punches but NO reconciled `attendance_record` row — i.e. a day
 * reconciliation SKIPPED (FR-HR-008a).
 *
 * This is the evidence the reports need to avoid lying quietly. Skips are transient — `reconcileDays`
 * returns them and nothing persists them — so the only durable signature of a skipped day is exactly
 * this: raw punches with no day row to show for them.
 */
export interface UnreconciledDayRow {
  /** The device enrolment code the punch carried; `employee_code`, not a uuid. */
  userId: string;
  attendanceDate: string;
  /** Re-derived from the same guards `reconcileDays` applies, using the FR-HR-008a vocabulary. */
  reason: 'UNKNOWN_EMPLOYEE_CODE' | 'NO_FINANCIAL_YEAR' | 'NO_PROJECT';
}

export interface EmployeeFilter {
  userId?: string;
  name?: string;
}

export const ATTENDANCE_REPORT_READ_PORT = Symbol('ATTENDANCE_REPORT_READ_PORT');

export interface AttendanceReportReadPort {
  /** Office-staff master, filtered and ordered by employee code (numeric-aware). */
  loadEmployees(companyId: string, filter: EmployeeFilter): Promise<EmployeeIdentity[]>;

  /** One row per employee per recorded day in the window — read from `attendance_record`. */
  loadDailyPunches(
    companyId: string,
    employeeIds: readonly string[],
    startDateText: string,
    endDateText: string,
  ): Promise<DailyPunchRow[]>;

  /**
   * Employee-days inside the window that have punches but no reconciled day row.
   *
   * Reads `checkin_log` deliberately — it is the only place a skipped day leaves a trace. A report
   * built on incomplete data must say so rather than render those days `Absent`.
   */
  loadUnreconciledDays(
    companyId: string,
    startDateText: string,
    endDateText: string,
  ): Promise<UnreconciledDayRow[]>;

  /** The configured late cut-off; falls back to 09:30 when the company has no row. */
  getAttendanceSetting(companyId: string): Promise<LateThreshold>;

  /** Weekday numbers that are weekends, e.g. `[5]` for a Friday weekend. */
  getWeeklyHolidayWeekdays(companyId: string): Promise<number[]>;

  /** Only the dates inside `dateList`, keyed by `'YYYY-MM-DD'`. */
  getGovernmentHolidayDates(
    companyId: string,
    dateList: readonly string[],
  ): Promise<Map<string, GovernmentHoliday>>;
}
