/**
 * AttendanceLogService — `GET /api/logs` and `/api/logs/export` (SUPPORTING_APIS_GUIDE §2).
 *
 * Despite the name this returns NO raw log rows: it is a per-employee attendance summary with a nested
 * `attendanceRecords` array. It is an older sibling of `/api/reports/range`, kept because the source
 * contract defines it, and it differs on purpose (§2.1):
 *
 *   | | /api/logs | /api/reports/range |
 *   |-|-----------|--------------------|
 *   | punches grouped | in Node | in SQL |
 *   | query scope | current PAGE of employees | ALL filtered employees |
 *   | report-wide `totals` | absent | present |
 *   | `label` / `lateAfter` / top-level holiday | absent | present |
 *   | absent days | counted only (`workingDays - presentCount`) | present as records |
 *   | default window | TODAY | current month so far |
 *   | one date bound alone | allowed | 400 |
 *
 * ⚠️ `attendanceRecords` is NOT gap-free: a non-holiday day with no punch is dropped from the array and
 * only shows in `absentCount`. A calendar UI needs `/api/reports/range`. The CSV export DOES emit absent
 * rows, because it iterates the date list rather than the records.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Actor } from '../../../../core/tenancy/tenant-context';
import {
  AttendanceReportStatus,
  HolidayType,
  STATUS,
  assertDateText,
  buildHolidayInfoMap,
  buildWeeklyHolidayDateSet,
  formatExcelText,
  formatLocalDate,
  formatLocalTime,
  listDatesInclusive,
  resolveAttendanceStatus,
  toCsv,
} from '../domain/attendance-rules';
import {
  ATTENDANCE_LOG_READ_PORT,
  AttendanceLogReadPort,
  PunchRow,
} from '../domain/ports/attendance-log.read.port';
import {
  ATTENDANCE_REPORT_READ_PORT,
  AttendanceReportReadPort,
} from '../domain/ports/attendance-report.read.port';
import { EmployeeIdentity, ReportPagination } from '../domain/attendance-report.model';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * One punch behind a merged day — the provenance of `checkInAt`/`checkOutAt`.
 *
 * A day is now routinely built from punches that arrived by different paths (a machine check-in and a
 * hand-keyed site visit in the same day). Reporting only first/last would hide that entirely, leaving
 * an operator unable to answer "where did this come from and where was he?".
 */
export interface AttendancePunchBreakdown {
  /** `HH:mm:ss` — the time-of-day part of the punch. */
  time: string;
  sourceType: string;
  projectId: string | null;
  projectName: string | null;
}

/** One day inside `attendanceRecords`. Holiday rows carry a synthetic `holiday-<date>` id. */
export interface AttendanceLogRecord {
  id: string;
  attendanceDate: string;
  holidayName?: string;
  holidayType?: HolidayType;
  deviceTimestamp: string | null;
  occurredAt: string | null;
  receivedAt: Date | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  status: AttendanceReportStatus;
  punchCount: number;
  /** Every punch under the day, chronological. Read-only and additive; `punchCount` is unchanged. */
  punches: AttendancePunchBreakdown[];
}

export interface AttendanceLogRow extends EmployeeIdentity {
  deviceTimestamp: null;
  occurredAt: null;
  receivedAt: null;
  status: AttendanceReportStatus;
  sourceType: 'EMPLOYEE_ATTENDANCE_SUMMARY';
  workingDays: number;
  onTimeCount: number;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  holidayCount: number;
  attendancePercentage: number;
  attendanceRecords: AttendanceLogRecord[];
}

export interface AttendanceLogResult {
  data: AttendanceLogRow[];
  pagination: ReportPagination;
}

export interface AttendanceLogFilter {
  page?: string | number;
  limit?: string | number;
  userId?: string;
  name?: string;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Window rules differ from the reports on purpose (§2.3): nothing given means TODAY (not the month), and
 * one bound alone is accepted rather than 400'd.
 */
function resolveLogWindow(filter: AttendanceLogFilter): { start: string; end: string } {
  const today = formatLocalDate();

  if (filter.date) {
    const single = assertDateText(filter.date, 'date');
    return { start: single, end: single };
  }
  if (!filter.dateFrom && !filter.dateTo) {
    return { start: today, end: today };
  }

  const from = filter.dateFrom ? assertDateText(filter.dateFrom, 'dateFrom') : null;
  const to = filter.dateTo ? assertDateText(filter.dateTo, 'dateTo') : null;

  return { start: from ?? to ?? today, end: to ?? today };
}

@Injectable()
export class AttendanceLogService {
  constructor(
    @Inject(ATTENDANCE_LOG_READ_PORT) private readonly punches: AttendanceLogReadPort,
    @Inject(ATTENDANCE_REPORT_READ_PORT) private readonly read: AttendanceReportReadPort,
  ) {}

  async getLogs(filter: AttendanceLogFilter, actor: Actor): Promise<AttendanceLogResult> {
    const { rows, pagination } = await this.build(filter, actor, false);
    return { data: rows, pagination };
  }

  /**
   * Flat CSV — one row per employee per DATE, so absent days appear here even though they are missing
   * from the JSON `attendanceRecords` (§2.4). `includeAll` bypasses paging: an export is the whole
   * filtered set.
   */
  async exportCsv(filter: AttendanceLogFilter, actor: Actor): Promise<string> {
    const window = resolveLogWindow(filter);
    const dateList = listDatesInclusive(window.start, window.end);
    const { rows } = await this.build(filter, actor, true);

    const csv: unknown[][] = [
      ['User ID', 'Name', 'Designation', 'Date', 'Checkin Time', 'Checkout Time', 'Status'],
    ];

    for (const employee of rows) {
      const byDate = new Map(employee.attendanceRecords.map((r) => [r.attendanceDate, r]));
      for (const attendanceDate of dateList) {
        const record = byDate.get(attendanceDate);
        csv.push([
          employee.userId,
          employee.name ?? '',
          employee.designation ?? '',
          formatExcelText(record?.attendanceDate || attendanceDate),
          formatExcelText(formatLocalTime(record?.checkInAt)),
          formatExcelText(formatLocalTime(record?.checkOutAt)),
          record?.status ?? STATUS.ABSENT,
        ]);
      }
    }

    return toCsv(csv);
  }

  private async build(
    filter: AttendanceLogFilter,
    actor: Actor,
    includeAll: boolean,
  ): Promise<{ rows: AttendanceLogRow[]; pagination: ReportPagination }> {
    const companyId = actor.companyId;
    const window = resolveLogWindow(filter);
    const dateList = listDatesInclusive(window.start, window.end);

    const parsedLimit = Number(filter.limit);
    const limit = includeAll
      ? Number.MAX_SAFE_INTEGER
      : Math.min(Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIMIT), MAX_LIMIT);
    const parsedPage = Number(filter.page);
    const page = Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1);
    const skip = includeAll ? 0 : (page - 1) * limit;

    const [allEmployees, threshold, weeklyWeekdays, governmentHolidays] = await Promise.all([
      this.read.loadEmployees(companyId, { userId: filter.userId, name: filter.name }),
      this.read.getAttendanceSetting(companyId),
      this.read.getWeeklyHolidayWeekdays(companyId),
      this.read.getGovernmentHolidayDates(companyId, dateList),
    ]);

    const holidayInfo = buildHolidayInfoMap(
      buildWeeklyHolidayDateSet(dateList, weeklyWeekdays),
      governmentHolidays,
    );
    const totalWorkingDays = Math.max(0, dateList.length - holidayInfo.size);

    const total = allEmployees.length;
    // Only the requested PAGE of employees is queried for punches — that is the documented difference
    // from /api/reports/range, which queries every filtered employee to build report-wide totals.
    const pageEmployees = includeAll ? allEmployees : allEmployees.slice(skip, skip + limit);

    const punches = await this.punches.listPunches(
      companyId,
      pageEmployees.map((e) => e.userId),
      window.start,
      window.end,
    );

    const byUser = new Map<string, PunchRow[]>();
    for (const punch of punches) {
      const list = byUser.get(punch.userId) ?? [];
      list.push(punch);
      byUser.set(punch.userId, list);
    }

    const rows = pageEmployees.map((employee) =>
      this.toRow(employee, byUser.get(employee.userId) ?? [], dateList, holidayInfo, threshold, totalWorkingDays),
    );

    return {
      rows,
      pagination: {
        page: includeAll ? 1 : page,
        limit: includeAll ? total : limit,
        total,
        totalPages: includeAll ? 1 : Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  private toRow(
    employee: EmployeeIdentity,
    punches: readonly PunchRow[],
    dateList: readonly string[],
    holidayInfo: ReadonlyMap<string, { name: string; type: HolidayType }>,
    threshold: { lateAfterHour: number; lateAfterMinute: number },
    totalWorkingDays: number,
  ): AttendanceLogRow {
    // Group punches by day. `deviceTimestamp` is zero-padded text and the adapter already ordered by it,
    // so the first entry of a day is the check-in and the last is the check-out.
    const byDay = new Map<string, PunchRow[]>();
    for (const punch of punches) {
      const day = punch.deviceTimestamp.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const list = byDay.get(day) ?? [];
      list.push(punch);
      byDay.set(day, list);
    }

    const records: AttendanceLogRecord[] = [];
    for (const attendanceDate of dateList) {
      const holiday = holidayInfo.get(attendanceDate);
      if (holiday) {
        records.push({
          id: `holiday-${attendanceDate}`,
          attendanceDate,
          holidayName: holiday.name,
          holidayType: holiday.type,
          deviceTimestamp: null,
          occurredAt: null,
          receivedAt: null,
          checkInAt: null,
          checkOutAt: null,
          status: STATUS.HOLIDAY,
          punchCount: 0,
          punches: [],
        });
        continue;
      }

      const dayPunches = byDay.get(attendanceDate);
      // NO gap filling: a non-holiday day without punches is simply omitted (§2.2).
      if (!dayPunches || dayPunches.length === 0) continue;

      const first = dayPunches[0] as PunchRow;
      const last = dayPunches[dayPunches.length - 1] as PunchRow;
      records.push({
        id: first.id,
        attendanceDate,
        deviceTimestamp: first.deviceTimestamp,
        occurredAt: first.deviceTimestamp,
        receivedAt: first.receivedAt,
        checkInAt: first.deviceTimestamp,
        checkOutAt: last.deviceTimestamp,
        status: resolveAttendanceStatus(first.deviceTimestamp, threshold),
        punchCount: dayPunches.length,
        // Already chronological — the adapter orders by (user_id, device_timestamp) and the grouping
        // above preserves that order, so no re-sort here.
        punches: dayPunches.map((punch) => ({
          time: punch.deviceTimestamp.slice(11),
          sourceType: punch.sourceType,
          projectId: punch.projectId,
          projectName: punch.projectName,
        })),
      });
    }

    const onTimeCount = records.filter((r) => r.status === STATUS.PRESENT).length;
    const lateCount = records.filter((r) => r.status === STATUS.LATE).length;
    // Same counting model as the reports: `lateCount` is a SUBSET of `presentCount`.
    const presentCount = onTimeCount + lateCount;
    const holidayCount = records.filter((r) => r.status === STATUS.HOLIDAY).length;
    // Derived, not counted — absent days are not in `records` at all.
    const absentCount = Math.max(0, totalWorkingDays - presentCount);

    return {
      id: employee.id,
      userId: employee.userId,
      name: employee.name,
      designation: employee.designation,
      deviceTimestamp: null,
      occurredAt: null,
      receivedAt: null,
      status: records[0]?.status ?? STATUS.ABSENT,
      sourceType: 'EMPLOYEE_ATTENDANCE_SUMMARY',
      workingDays: totalWorkingDays,
      onTimeCount,
      presentCount,
      absentCount,
      lateCount,
      holidayCount,
      attendancePercentage:
        totalWorkingDays > 0 ? Math.round((presentCount / totalWorkingDays) * 1000) / 10 : 0,
      attendanceRecords: records,
    };
  }
}
