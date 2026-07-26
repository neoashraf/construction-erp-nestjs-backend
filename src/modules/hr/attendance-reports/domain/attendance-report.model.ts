/**
 * The exact JSON shapes returned by `/api/reports/{daily,range,summary}` (REPORTS_MODULE_GUIDE §4).
 * These interfaces are the contract — field names, order and nullability all mirror the source project
 * so a client written against it works here unchanged. `@NoEnvelope()` on the controller keeps the
 * platform `{ data, meta }` wrapper off these bodies.
 */
import { AttendanceReportStatus, HolidayInfo, HolidayType } from './attendance-rules';

/** Per-employee counters. `lateCount` is a SUBSET of `presentCount`, not a sibling bucket (§3.5). */
export interface AttendanceTotals {
  workingDays: number;
  onTimeCount: number;
  lateCount: number;
  presentCount: number;
  absentCount: number;
  holidayCount: number;
  attendancePercentage: number;
}

/** Report-wide totals: always the whole filtered set, never just the current page (§3.6). */
export interface ReportWideTotals extends AttendanceTotals {
  totalEmployees: number;
}

export interface ReportPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** One employee's one day inside the gap-free calendar (§3.2). */
export interface AttendanceDayRecord {
  attendanceDate: string;
  status: AttendanceReportStatus;
  holidayName: string | null;
  holidayType: HolidayType | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  punchCount: number;
}

/** `AttendanceDayRecord` + the display-ready times the range report adds. */
export interface AttendanceDayRecordDto extends AttendanceDayRecord {
  checkInTime: string;
  checkOutTime: string;
}

export interface EmployeeIdentity {
  id: string;
  userId: string;
  name: string;
  designation: string | null;
}

/** The internal matrix cell: identity + its own totals + its full day list. */
export interface EmployeeMatrixRow extends EmployeeIdentity {
  totals: AttendanceTotals;
  records: AttendanceDayRecord[];
}

/** Everything the three reports and three exports are shaped from (`buildAttendanceMatrix`). */
export interface AttendanceMatrix {
  window: { start: string; end: string };
  dateList: string[];
  holidayInfo: Map<string, HolidayInfo>;
  threshold: { lateAfterHour: number; lateAfterMinute: number };
  totalWorkingDays: number;
  totals: ReportWideTotals;
  data: EmployeeMatrixRow[];
  pagination: ReportPagination;
}

// ── report bodies ─────────────────────────────────────────────────────────────────────────────────

export interface DailyReportRow extends EmployeeIdentity {
  attendanceDate: string;
  status: AttendanceReportStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  checkInTime: string;
  checkOutTime: string;
  punchCount: number;
}

export interface DailyReport {
  date: string;
  isHoliday: boolean;
  holiday: HolidayInfo | null;
  lateAfter: string;
  totals: ReportWideTotals;
  data: DailyReportRow[];
  pagination: ReportPagination;
}

export interface RangeReportRow extends EmployeeIdentity, AttendanceTotals {
  records: AttendanceDayRecordDto[];
}

export interface RangeReport {
  dateFrom: string;
  dateTo: string;
  label: string;
  totalDays: number;
  totalWorkingDays: number;
  lateAfter: string;
  totals: ReportWideTotals;
  data: RangeReportRow[];
  pagination: ReportPagination;
}

/** `range` minus the per-employee `records` array (§4.4). */
export type SummaryReportRow = EmployeeIdentity & AttendanceTotals;

export interface SummaryReport extends Omit<RangeReport, 'data'> {
  data: SummaryReportRow[];
}

// ── service inputs ────────────────────────────────────────────────────────────────────────────────

export interface AttendanceReportFilter {
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
  name?: string;
  page?: string | number;
  limit?: string | number;
}
