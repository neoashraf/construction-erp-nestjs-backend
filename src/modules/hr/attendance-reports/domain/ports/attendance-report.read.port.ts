/**
 * The four reads the attendance reports need, behind one port so `AttendanceReportService` stays pure
 * business logic and is unit-testable with a fake (REPORTS_MODULE_GUIDE §6.2 `queries/settings.js` +
 * `queries/holidays.js` + the two loaders in `queries/reports.js`, collapsed into one port here).
 * Every method is companyId-scoped — an unscoped read is a cross-tenant leak (ADR-0002 F3).
 */
import { EmployeeIdentity } from '../attendance-report.model';
import { GovernmentHoliday, LateThreshold } from '../attendance-rules';

/** One employee's punches collapsed to a single day. */
export interface DailyPunchRow {
  /** `employee.id` — the join key; the report exposes `userId` (= `employee_code`) instead. */
  employeeId: string;
  attendanceDate: string;
  /** `'YYYY-MM-DD HH:mm:ss'`, or null when that day has no check-in. */
  checkInAt: string | null;
  checkOutAt: string | null;
  punchCount: number;
}

export interface EmployeeFilter {
  userId?: string;
  name?: string;
}

export const ATTENDANCE_REPORT_READ_PORT = Symbol('ATTENDANCE_REPORT_READ_PORT');

export interface AttendanceReportReadPort {
  /** Office-staff master, filtered and ordered by employee code (numeric-aware). */
  loadEmployees(companyId: string, filter: EmployeeFilter): Promise<EmployeeIdentity[]>;

  /** One row per employee per worked day in the window — aggregated in SQL, never in Node. */
  loadDailyPunches(
    companyId: string,
    employeeIds: readonly string[],
    startDateText: string,
    endDateText: string,
  ): Promise<DailyPunchRow[]>;

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
