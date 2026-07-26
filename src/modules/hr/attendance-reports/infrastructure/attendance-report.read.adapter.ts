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
      // `check_in`/`check_out` are `time`; the cast to `interval` is explicit so the `to_char` overload
      // resolves without relying on the implicit time→interval cast, and so any fractional seconds are
      // truncated to the fixed `HH:mm:ss` width the report format expects.
      `SELECT a.employee_id::text                       AS "employeeId",
              to_char(a.attendance_date, 'YYYY-MM-DD')  AS "attendanceDate",
              MIN(to_char(a.attendance_date, 'YYYY-MM-DD') || ' ' || to_char(a.check_in::interval, 'HH24:MI:SS'))
                                                        AS "checkInAt",
              MAX(to_char(a.attendance_date, 'YYYY-MM-DD') || ' ' || to_char(a.check_out::interval, 'HH24:MI:SS'))
                                                        AS "checkOutAt",
              SUM((a.check_in IS NOT NULL)::int + (a.check_out IS NOT NULL)::int)::int
                                                        AS "punchCount"
         FROM attendance_record a
        WHERE a.company_id = $1
          AND a.mode = 'OFFICE'
          AND a.attendance_date BETWEEN $2::date AND $3::date
          AND a.employee_id = ANY($4::uuid[])
        GROUP BY a.employee_id, a.attendance_date`,
      [companyId, startDateText, endDateText, [...employeeIds]],
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
