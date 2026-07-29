/**
 * AttendanceReportService — the whole business logic for the three attendance reports and their three
 * CSV exports (REPORTS_MODULE_GUIDE §6.3, ported from `src/queries/reports.js`).
 *
 * ONE core function, `buildAttendanceMatrix`, produces a per-employee × per-date grid; the six public
 * methods only re-shape it. That is the guide's central design decision: the counting model is written
 * once, so `daily`, `range` and `summary` can never disagree about a number.
 *
 * The invariants that must not drift when this is touched:
 *   - Gap-free calendar (§3.2): EVERY date in the window yields a record — holiday, absent, or punched.
 *   - Holiday precedence (§3.3): a government holiday overrides a weekly holiday on the same date.
 *   - Counting model (§3.5): `presentCount = onTimeCount + lateCount` — `lateCount` is a SUBSET of
 *     present, not a sibling bucket, so `Working 22 / Present 22 / Late 2 / Absent 0` is correct.
 *   - Totals vs pagination (§3.6): totals are computed over the whole filtered set; only `data` is
 *     sliced. Exports always run with `includeAll`, so a file is never a single UI page.
 *
 * Everything is `companyId`-scoped through the read port (ADR-0002 F3).
 */
import { Inject, Injectable } from '@nestjs/common';
import { Actor } from '../../../../core/tenancy/tenant-context';
import {
  AttendanceDayRecord,
  AttendanceMatrix,
  AttendanceReportFilter,
  AttendanceTotals,
  DailyReport,
  EmployeeMatrixRow,
  RangeReport,
  ReportWideTotals,
  SummaryReport,
  UnreconciledSummary,
} from '../domain/attendance-report.model';
import {
  ATTENDANCE_REPORT_READ_PORT,
  AttendanceReportReadPort,
  UnreconciledDayRow,
} from '../domain/ports/attendance-report.read.port';
import {
  AttendanceReportStatus,
  DAY_STATUS_TO_REPORT,
  LateThreshold,
  STATUS,
  WEEKDAY_NAMES,
  assertDateText,
  badRequest,
  buildHolidayInfoMap,
  buildRangeLabel,
  buildWeeklyHolidayDateSet,
  formatExcelText,
  formatLocalDate,
  formatLocalTime,
  getWeekday,
  countDaysInclusive,
  listDatesInclusive,
  resolveAttendanceStatus,
  toCsv,
} from '../domain/attendance-rules';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
export const MAX_RANGE_DAYS = 366;

interface ResolvedPagination {
  page: number;
  limit: number;
  skip: number;
}

interface MatrixOptions extends AttendanceReportFilter {
  includeAll?: boolean;
}

function resolvePagination({
  page,
  limit,
  includeAll,
}: {
  page?: string | number;
  limit?: string | number;
  includeAll?: boolean;
}): ResolvedPagination {
  if (includeAll) {
    return { page: 1, limit: Number.MAX_SAFE_INTEGER, skip: 0 };
  }

  const parsedLimit = Number(limit);
  const parsedPage = Number(page);
  const safeLimit = Math.min(
    Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const safePage = Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1);

  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}

/**
 * Resolve the requested window. Both ends absent means "this month so far", which keeps the endpoints
 * usable without query parameters; supplying only one end is rejected because the intended window would
 * be a guess (§3.1).
 */
function resolveWindow({
  date,
  dateFrom,
  dateTo,
}: AttendanceReportFilter): { start: string; end: string } {
  if (date) {
    const single = assertDateText(date, 'date');
    return { start: single, end: single };
  }

  if (!dateFrom && !dateTo) {
    const today = new Date();
    return {
      start: formatLocalDate(new Date(today.getFullYear(), today.getMonth(), 1)),
      end: formatLocalDate(today),
    };
  }

  if (!dateFrom || !dateTo) {
    throw badRequest('dateFrom and dateTo must be supplied together');
  }

  const start = assertDateText(dateFrom, 'dateFrom');
  const end = assertDateText(dateTo, 'dateTo');

  if (start > end) {
    throw badRequest('dateFrom must not be after dateTo');
  }

  // Measure the REQUESTED span, not the clamped one: `listDatesInclusive` stops at today, so
  // using it here would let a 400-day window ending in the future slip past the limit as "0
  // days" and then run an unbounded query.
  const dayCount = countDaysInclusive(start, end);

  if (dayCount > MAX_RANGE_DAYS) {
    throw badRequest(
      `Date range must not exceed ${MAX_RANGE_DAYS} days (requested ${dayCount})`,
    );
  }

  return { start, end };
}

function formatThreshold(threshold: LateThreshold): string {
  return `${String(threshold.lateAfterHour).padStart(2, '0')}:${String(
    threshold.lateAfterMinute,
  ).padStart(2, '0')}`;
}

function emptyTotals(): AttendanceTotals {
  return {
    workingDays: 0,
    onTimeCount: 0,
    lateCount: 0,
    presentCount: 0,
    absentCount: 0,
    holidayCount: 0,
    attendancePercentage: 0,
    paidLeaveCount: 0,
    unpaidLeaveCount: 0,
  };
}

/** How many skipped employee-days a report body carries in full before it just reports the count. */
const UNRECONCILED_SAMPLE_LIMIT = 20;

function summarizeUnreconciled(rows: readonly UnreconciledDayRow[]): UnreconciledSummary {
  const reasons: Record<string, number> = {};
  for (const row of rows) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;

  return {
    days: rows.length,
    reasons,
    sample: rows.slice(0, UNRECONCILED_SAMPLE_LIMIT).map((row) => ({
      userId: row.userId,
      attendanceDate: row.attendanceDate,
      reason: row.reason,
    })),
  };
}

/**
 * The day's report status.
 *
 * A stored `day_status` wins for the three statuses that have no punch representation — a leave or an
 * explicit absence is a fact somebody asserted, not something to infer from missing times. `PRESENT`
 * falls through to the threshold comparison, because Present-vs-Late is DERIVED and the stored status
 * cannot express it. A row with times but no status (reconciliation creates these) does the same.
 */
function resolveDayStatus(
  row: { checkInAt: string | null; dayStatus: string | null },
  threshold: LateThreshold,
): AttendanceReportStatus {
  const declared = row.dayStatus ? DAY_STATUS_TO_REPORT[row.dayStatus] : undefined;
  if (declared) return declared;
  return resolveAttendanceStatus(row.checkInAt, threshold);
}

/**
 * Counting model (§3.5):
 *   presentCount = onTimeCount + lateCount   (days the employee turned up at all)
 *   workingDays  = presentCount + absentCount
 * `lateCount` is therefore a subset of `presentCount`, not a sibling bucket.
 */
function summarizeRecords(
  records: readonly AttendanceDayRecord[],
  totalWorkingDays: number,
): AttendanceTotals {
  const totals = emptyTotals();
  totals.workingDays = totalWorkingDays;

  for (const record of records) {
    if (record.status === STATUS.PRESENT) {
      totals.onTimeCount += 1;
    } else if (record.status === STATUS.LATE) {
      totals.lateCount += 1;
    } else if (record.status === STATUS.ABSENT) {
      totals.absentCount += 1;
    } else if (record.status === STATUS.HOLIDAY) {
      totals.holidayCount += 1;
    } else if (record.status === STATUS.PAID_LEAVE) {
      // NOT an absence. Payroll pays this day, so folding it into absentCount is exactly the
      // disagreement between the report and the payslip that this brief exists to remove.
      totals.paidLeaveCount += 1;
    } else if (record.status === STATUS.UNPAID_LEAVE) {
      totals.unpaidLeaveCount += 1;
    }
  }

  totals.presentCount = totals.onTimeCount + totals.lateCount;
  totals.attendancePercentage =
    totalWorkingDays > 0
      ? Math.round((totals.presentCount / totalWorkingDays) * 1000) / 10
      : 0;

  return totals;
}

function aggregateTotals(
  employees: readonly EmployeeMatrixRow[],
  totalWorkingDays: number,
): AttendanceTotals {
  const totals = emptyTotals();
  totals.workingDays = totalWorkingDays;

  for (const employee of employees) {
    totals.onTimeCount += employee.totals.onTimeCount;
    totals.lateCount += employee.totals.lateCount;
    totals.absentCount += employee.totals.absentCount;
    totals.holidayCount += employee.totals.holidayCount;
    totals.paidLeaveCount += employee.totals.paidLeaveCount;
    totals.unpaidLeaveCount += employee.totals.unpaidLeaveCount;
  }

  totals.presentCount = totals.onTimeCount + totals.lateCount;

  const expected = totalWorkingDays * employees.length;
  totals.attendancePercentage =
    expected > 0 ? Math.round((totals.presentCount / expected) * 1000) / 10 : 0;

  return totals;
}

@Injectable()
export class AttendanceReportService {
  constructor(
    @Inject(ATTENDANCE_REPORT_READ_PORT) private readonly read: AttendanceReportReadPort,
  ) {}

  /**
   * Per-employee, per-date attendance for the window. Every date in the window produces a record — a day
   * with no check-in becomes `Absent` and a weekly/government holiday becomes `Holiday` — so the caller
   * renders a gap-free calendar with no client-side gap filling.
   */
  async buildAttendanceMatrix(options: MatrixOptions, actor: Actor): Promise<AttendanceMatrix> {
    const { date, dateFrom, dateTo, userId, name, page, limit, includeAll = false } = options;
    const companyId = actor.companyId;

    const window = resolveWindow({ date, dateFrom, dateTo });
    const dateList = listDatesInclusive(window.start, window.end);
    const pagination = resolvePagination({ page, limit, includeAll });

    const [employees, threshold, weeklyHolidayWeekdays, governmentHolidayMap, unreconciledRows] =
      await Promise.all([
        this.read.loadEmployees(companyId, { userId, name }),
        this.read.getAttendanceSetting(companyId),
        this.read.getWeeklyHolidayWeekdays(companyId),
        this.read.getGovernmentHolidayDates(companyId, dateList),
        // Deliberately NOT filtered by the employee filter: a day skipped for an UNKNOWN employee
        // code has no employee row to filter by, and that is the very case most worth surfacing.
        this.read.loadUnreconciledDays(companyId, window.start, window.end),
      ]);

    const holidayInfo = buildHolidayInfoMap(
      buildWeeklyHolidayDateSet(dateList, weeklyHolidayWeekdays),
      governmentHolidayMap,
    );
    const totalWorkingDays = Math.max(0, dateList.length - holidayInfo.size);

    const total = employees.length;

    // Punches are aggregated for every matching employee, not just the requested page, so the
    // report-wide totals describe the whole filtered set rather than one page of it (§3.6).
    const punchRows = await this.read.loadDailyPunches(
      companyId,
      employees.map((employee) => employee.id),
      window.start,
      window.end,
    );

    const punchesByEmployeeId = new Map<string, Map<string, (typeof punchRows)[number]>>();
    for (const row of punchRows) {
      const dayMap = punchesByEmployeeId.get(row.employeeId) ?? new Map();
      dayMap.set(row.attendanceDate, row);
      punchesByEmployeeId.set(row.employeeId, dayMap);
    }

    const allData: EmployeeMatrixRow[] = employees.map((employee) => {
      const dayMap = punchesByEmployeeId.get(employee.id) ?? new Map();

      const records: AttendanceDayRecord[] = dateList.map((attendanceDate) => {
        const holiday = holidayInfo.get(attendanceDate);

        if (holiday) {
          return {
            attendanceDate,
            status: STATUS.HOLIDAY as AttendanceReportStatus,
            holidayName: holiday.name,
            holidayType: holiday.type,
            checkInAt: null,
            checkOutAt: null,
            punchCount: 0,
          };
        }

        const punch = dayMap.get(attendanceDate);

        if (!punch) {
          // No row for a working day. It reads Absent — the same as an explicitly-marked ABSENT —
          // because absence of data is indistinguishable from absence of the person, and payroll
          // deducts it either way (FR-HR-013a). Whether the row is MISSING because reconciliation
          // skipped it is answered by `unreconciled`, not by silently changing this cell.
          return {
            attendanceDate,
            status: STATUS.ABSENT as AttendanceReportStatus,
            holidayName: null,
            holidayType: null,
            checkInAt: null,
            checkOutAt: null,
            punchCount: 0,
          };
        }

        return {
          attendanceDate,
          status: resolveDayStatus(punch, threshold),
          holidayName: null,
          holidayType: null,
          checkInAt: punch.checkInAt,
          checkOutAt: punch.checkOutAt,
          punchCount: punch.punchCount,
        };
      });

      return {
        id: employee.id,
        userId: employee.userId,
        name: employee.name,
        designation: employee.designation,
        totals: summarizeRecords(records, totalWorkingDays),
        records,
      };
    });

    const totals: ReportWideTotals = {
      totalEmployees: total,
      ...aggregateTotals(allData, totalWorkingDays),
    };

    return {
      window,
      dateList,
      holidayInfo,
      threshold,
      totalWorkingDays,
      totals,
      data: includeAll
        ? allData
        : allData.slice(pagination.skip, pagination.skip + pagination.limit),
      pagination: {
        page: pagination.page,
        limit: includeAll ? total : pagination.limit,
        total,
        totalPages: includeAll ? 1 : Math.max(1, Math.ceil(total / pagination.limit)),
      },
      unreconciled: summarizeUnreconciled(unreconciledRows),
    };
  }

  /** Report 1 — one row per employee for a single day. */
  async getDailyReport(filter: AttendanceReportFilter, actor: Actor): Promise<DailyReport> {
    const matrix = await this.buildAttendanceMatrix(
      {
        date: filter.date || formatLocalDate(),
        page: filter.page,
        limit: filter.limit,
        userId: filter.userId,
        name: filter.name,
      },
      actor,
    );

    const reportDate = matrix.window.start;
    const holiday = matrix.holidayInfo.get(reportDate) ?? null;

    const data = matrix.data.map((employee) => {
      const record = employee.records[0] as AttendanceDayRecord;

      return {
        id: employee.id,
        userId: employee.userId,
        name: employee.name,
        designation: employee.designation,
        attendanceDate: reportDate,
        status: record.status,
        checkInAt: record.checkInAt,
        checkOutAt: record.checkOutAt,
        checkInTime: formatLocalTime(record.checkInAt),
        checkOutTime: formatLocalTime(record.checkOutAt),
        punchCount: record.punchCount,
      };
    });

    return {
      date: reportDate,
      isHoliday: Boolean(holiday),
      holiday: holiday ? { name: holiday.name, type: holiday.type } : null,
      lateAfter: formatThreshold(matrix.threshold),
      totals: matrix.totals,
      data,
      pagination: matrix.pagination,
      unreconciled: matrix.unreconciled,
    };
  }

  /** Report 2 — per-employee day-by-day breakdown across a date range. */
  async getRangeReport(filter: AttendanceReportFilter, actor: Actor): Promise<RangeReport> {
    const matrix = await this.buildAttendanceMatrix(
      {
        dateFrom: filter.dateFrom,
        dateTo: filter.dateTo,
        page: filter.page,
        limit: filter.limit,
        userId: filter.userId,
        name: filter.name,
      },
      actor,
    );

    return {
      dateFrom: matrix.window.start,
      dateTo: matrix.window.end,
      label: buildRangeLabel(matrix.window.start, matrix.window.end),
      totalDays: matrix.dateList.length,
      totalWorkingDays: matrix.totalWorkingDays,
      lateAfter: formatThreshold(matrix.threshold),
      totals: matrix.totals,
      data: matrix.data.map((employee) => ({
        id: employee.id,
        userId: employee.userId,
        name: employee.name,
        designation: employee.designation,
        ...employee.totals,
        records: employee.records.map((record) => ({
          ...record,
          checkInTime: formatLocalTime(record.checkInAt),
          checkOutTime: formatLocalTime(record.checkOutAt),
        })),
      })),
      pagination: matrix.pagination,
      unreconciled: matrix.unreconciled,
    };
  }

  /** Report 3 — totals only, no per-day rows. */
  async getSummaryReport(filter: AttendanceReportFilter, actor: Actor): Promise<SummaryReport> {
    const matrix = await this.buildAttendanceMatrix(
      {
        dateFrom: filter.dateFrom,
        dateTo: filter.dateTo,
        page: filter.page,
        limit: filter.limit,
        userId: filter.userId,
        name: filter.name,
      },
      actor,
    );

    return {
      dateFrom: matrix.window.start,
      dateTo: matrix.window.end,
      label: buildRangeLabel(matrix.window.start, matrix.window.end),
      totalDays: matrix.dateList.length,
      totalWorkingDays: matrix.totalWorkingDays,
      lateAfter: formatThreshold(matrix.threshold),
      totals: matrix.totals,
      data: matrix.data.map((employee) => ({
        id: employee.id,
        userId: employee.userId,
        name: employee.name,
        designation: employee.designation,
        ...employee.totals,
      })),
      pagination: matrix.pagination,
      unreconciled: matrix.unreconciled,
    };
  }

  /**
   * Daily export. `includeAll` bypasses pagination so the file always covers every employee matching the
   * filters, not just the page the UI happens to be showing (§3.6).
   */
  async exportDailyReportCsv(filter: AttendanceReportFilter, actor: Actor): Promise<string> {
    const matrix = await this.buildAttendanceMatrix(
      {
        date: filter.date || formatLocalDate(),
        userId: filter.userId,
        name: filter.name,
        includeAll: true,
      },
      actor,
    );

    const reportDate = matrix.window.start;
    // Keyed by the STATUS map rather than four literals, so a new status can never be counted
    // into `undefined` and silently vanish from the footer.
    const statusCounts: Record<AttendanceReportStatus, number> = {
      [STATUS.PRESENT]: 0,
      [STATUS.LATE]: 0,
      [STATUS.ABSENT]: 0,
      [STATUS.HOLIDAY]: 0,
      [STATUS.PAID_LEAVE]: 0,
      [STATUS.UNPAID_LEAVE]: 0,
    };

    const rows: unknown[][] = [
      [`Daily Attendance ${reportDate}`],
      [],
      ['User ID', 'Name', 'Designation', 'Date', 'Status', 'Checkin Time', 'Checkout Time'],
    ];

    for (const employee of matrix.data) {
      const record = employee.records[0] as AttendanceDayRecord;
      statusCounts[record.status] += 1;

      rows.push([
        employee.userId,
        employee.name,
        employee.designation ?? '',
        formatExcelText(reportDate),
        record.status,
        formatExcelText(formatLocalTime(record.checkInAt)),
        formatExcelText(formatLocalTime(record.checkOutAt)),
      ]);
    }

    rows.push([]);
    rows.push([
      'Totals',
      `Present: ${statusCounts[STATUS.PRESENT]}`,
      `Late: ${statusCounts[STATUS.LATE]}`,
      `Absent: ${statusCounts[STATUS.ABSENT]}`,
      `Holiday: ${statusCounts[STATUS.HOLIDAY]}`,
      `Paid leave: ${statusCounts[STATUS.PAID_LEAVE]}`,
      `Unpaid leave: ${statusCounts[STATUS.UNPAID_LEAVE]}`,
    ]);

    return toCsv(rows);
  }

  /**
   * Range export. Identity columns are written on that employee's first row only and a blank row
   * separates employees, matching the grouped layout of the sample workbook. The per-employee totals
   * close each group so the file carries the same numbers as the summary table in the UI.
   */
  async exportRangeReportCsv(filter: AttendanceReportFilter, actor: Actor): Promise<string> {
    const matrix = await this.buildAttendanceMatrix(
      {
        dateFrom: filter.dateFrom,
        dateTo: filter.dateTo,
        userId: filter.userId,
        name: filter.name,
        includeAll: true,
      },
      actor,
    );

    const label = buildRangeLabel(matrix.window.start, matrix.window.end);
    const rows: unknown[][] = [
      [`Attendance Details ${label}`],
      [],
      [
        'User ID',
        'Name',
        'Designation',
        'Date',
        'Day',
        'Status',
        'Checkin Time',
        'Checkout Time',
        'Holiday',
      ],
    ];

    for (const employee of matrix.data) {
      rows.push([]);

      employee.records.forEach((record, index) => {
        rows.push([
          index === 0 ? employee.userId : '',
          index === 0 ? employee.name : '',
          index === 0 ? employee.designation ?? '' : '',
          formatExcelText(record.attendanceDate),
          WEEKDAY_NAMES[getWeekday(record.attendanceDate)],
          record.status,
          formatExcelText(formatLocalTime(record.checkInAt)),
          formatExcelText(formatLocalTime(record.checkOutAt)),
          record.holidayName ?? '',
        ]);
      });

      const totals = employee.totals;

      rows.push([
        '',
        'Totals',
        '',
        `Working: ${totals.workingDays}`,
        '',
        `Present: ${totals.presentCount}`,
        `Late: ${totals.lateCount}`,
        `Absent: ${totals.absentCount}`,
        `Holidays: ${totals.holidayCount}`,
        `Paid leave: ${totals.paidLeaveCount}`,
        `Unpaid leave: ${totals.unpaidLeaveCount}`,
      ]);
    }

    return toCsv(rows);
  }

  /**
   * Summary export as one row per employee, mirroring the columns of the summary table in the UI.
   * `Present` counts every day worked, so it already includes the `Late` column.
   */
  async exportSummaryReportCsv(filter: AttendanceReportFilter, actor: Actor): Promise<string> {
    const matrix = await this.buildAttendanceMatrix(
      {
        dateFrom: filter.dateFrom,
        dateTo: filter.dateTo,
        userId: filter.userId,
        name: filter.name,
        includeAll: true,
      },
      actor,
    );

    const label = buildRangeLabel(matrix.window.start, matrix.window.end);
    const rows: unknown[][] = [
      [`Attendance Summary ${label}`],
      [],
      [
        'User ID',
        'Name',
        'Designation',
        'Working',
        'Present',
        'On Time',
        'Late',
        'Absent',
        'Paid Leave',
        'Unpaid Leave',
        'Holidays',
        'Attendance %',
      ],
    ];

    for (const employee of matrix.data) {
      const totals = employee.totals;

      rows.push([
        employee.userId,
        employee.name,
        employee.designation ?? '',
        totals.workingDays,
        totals.presentCount,
        totals.onTimeCount,
        totals.lateCount,
        totals.absentCount,
        totals.paidLeaveCount,
        totals.unpaidLeaveCount,
        totals.holidayCount,
        totals.attendancePercentage,
      ]);
    }

    const totals = matrix.totals;

    rows.push([]);
    rows.push([
      '',
      `Totals (${totals.totalEmployees} ${totals.totalEmployees === 1 ? 'employee' : 'employees'})`,
      '',
      matrix.totalWorkingDays,
      totals.presentCount,
      totals.onTimeCount,
      totals.lateCount,
      totals.absentCount,
      totals.paidLeaveCount,
      totals.unpaidLeaveCount,
      totals.holidayCount,
      totals.attendancePercentage,
    ]);

    return toCsv(rows);
  }
}
