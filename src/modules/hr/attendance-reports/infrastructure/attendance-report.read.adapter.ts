/**
 * AttendanceReportReadAdapter (INFRASTRUCTURE) — the SQL behind the attendance reports. Reads HR's own
 * `employee` + `attendance_record` and the three config tables; writes nothing.
 *
 * The source project aggregated punch rows with `MIN/MAX(deviceTimestamp)` over a TEXT column
 * (REPORTS_MODULE_GUIDE §2). Here `attendance_record` already holds one OFFICE row per employee per day
 * (`uq_attendance_office_employee_day`) with `check_in` / `check_out` as `time`, so the adapter composes
 * the SAME `'YYYY-MM-DD HH:mm:ss'` string in SQL and keeps the MIN/MAX + GROUP BY anyway — zero-padded
 * text means lexicographic order is chronological order, so the first/last punch semantics survive even
 * if a day ever grows a second row. Aggregation stays in Postgres, not Node: a month-wide report returns
 * one row per worked day, not one per punch (§8).
 *
 * `name` is matched with `position(lower(...) in lower(...))` rather than ILIKE so a user typing `%` or
 * `_` gets a literal match instead of an accidental wildcard.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { EmployeeIdentity } from '../domain/attendance-report.model';
import { GovernmentHoliday, LateThreshold, compareUserIds } from '../domain/attendance-rules';
import {
  AttendanceReportReadPort,
  DailyPunchRow,
  EmployeeFilter,
} from '../domain/ports/attendance-report.read.port';

/** Used when the company has no `attendance_setting` row, so an un-configured DB still reports. */
const DEFAULT_THRESHOLD: LateThreshold = { lateAfterHour: 9, lateAfterMinute: 30 };

@Injectable()
export class AttendanceReportReadAdapter implements AttendanceReportReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async loadEmployees(companyId: string, filter: EmployeeFilter): Promise<EmployeeIdentity[]> {
    const rows: Array<{
      id: string;
      userId: string;
      name: string;
      designation: string | null;
    }> = await getManager(this.dataSource).query(
      `SELECT e.id::text          AS "id",
              e.employee_code     AS "userId",
              e.name              AS "name",
              e.designation       AS "designation"
         FROM employee e
        WHERE e.company_id = $1
          AND e.deleted_at IS NULL
          AND ($2::text IS NULL OR e.employee_code = $2)
          AND ($3::text IS NULL OR position(lower($3) in lower(e.name)) > 0)`,
      [companyId, filter.userId ?? null, filter.name ?? null],
    );

    return rows.sort((a, b) => compareUserIds(a.userId, b.userId));
  }

  async loadDailyPunches(
    companyId: string,
    employeeIds: readonly string[],
    startDateText: string,
    endDateText: string,
  ): Promise<DailyPunchRow[]> {
    if (employeeIds.length === 0) {
      return [];
    }

    const rows: Array<{
      employeeId: string;
      attendanceDate: string;
      checkInAt: string | null;
      checkOutAt: string | null;
      punchCount: number;
    }> = await getManager(this.dataSource).query(
      // Reads `checkin_log` — the SAME source as `/api/logs` (attendance-log.read.adapter).
      //
      // This deliberately does NOT read `attendance_record`. That table is populated only by
      // reconciliation, which skips any employee-day it cannot place (no project, no financial
      // year covering the date, an already-confirmed row). Reading it here made the two views
      // disagree over the very same window: the log view showed real Present/Late counts from
      // the raw punches while the summary reported everyone Absent, because nothing had
      // reconciled. Attendance *reporting* must reflect what the device actually recorded;
      // `attendance_record` stays the ledger-facing projection used for payroll.
      //
      // `device_timestamp` is zero-padded text, so lexicographic MIN/MAX are chronological and
      // `substring(...,1,10)` is the calendar date — no timezone conversion anywhere in SQL.
      `SELECT e.id::text                                  AS "employeeId",
              substring(c.device_timestamp from 1 for 10) AS "attendanceDate",
              MIN(c.device_timestamp)                     AS "checkInAt",
              MAX(c.device_timestamp)                     AS "checkOutAt",
              COUNT(*)::int                               AS "punchCount"
         FROM "checkin_log" c
         JOIN "employee" e
           ON e.company_id = c.company_id
          AND e.employee_code = c.user_id
          AND e.deleted_at IS NULL
        WHERE c.company_id = $1
          AND c.device_timestamp >= $2 AND c.device_timestamp <= $3
          AND e.id = ANY($4::uuid[])
        GROUP BY e.id, substring(c.device_timestamp from 1 for 10)`,
      [companyId, `${startDateText} 00:00:00`, `${endDateText} 23:59:59`, [...employeeIds]],
    );

    return rows;
  }

  async getAttendanceSetting(companyId: string): Promise<LateThreshold> {
    const rows: Array<{ lateAfterHour: number; lateAfterMinute: number }> = await getManager(
      this.dataSource,
    ).query(
      `SELECT "late_after_hour"::int   AS "lateAfterHour",
              "late_after_minute"::int AS "lateAfterMinute"
         FROM "attendance_setting"
        WHERE "company_id" = $1
        LIMIT 1`,
      [companyId],
    );

    const row = rows[0];
    if (!row) return { ...DEFAULT_THRESHOLD };

    return { lateAfterHour: row.lateAfterHour, lateAfterMinute: row.lateAfterMinute };
  }

  async getWeeklyHolidayWeekdays(companyId: string): Promise<number[]> {
    const rows: Array<{ weekday: number }> = await getManager(this.dataSource).query(
      `SELECT "weekday"::int AS "weekday"
         FROM "weekly_holiday"
        WHERE "company_id" = $1
        ORDER BY "weekday" ASC`,
      [companyId],
    );

    return rows.map((row) => row.weekday);
  }

  async getGovernmentHolidayDates(
    companyId: string,
    dateList: readonly string[],
  ): Promise<Map<string, GovernmentHoliday>> {
    if (dateList.length === 0) {
      return new Map();
    }

    const rows: Array<{ date: string; name: string; localName: string | null }> = await getManager(
      this.dataSource,
    ).query(
      `SELECT to_char("date", 'YYYY-MM-DD') AS "date",
              "name"                        AS "name",
              "local_name"                  AS "localName"
         FROM "government_holiday"
        WHERE "company_id" = $1
          AND "date" = ANY($2::date[])`,
      [companyId, [...dateList]],
    );

    return new Map(
      rows.map((row) => [
        row.date,
        { date: row.date, name: row.name, localName: row.localName },
      ]),
    );
  }
}
