/**
 * AttendanceReportReadAdapter (INFRASTRUCTURE) — the SQL behind the attendance reports. Reads HR's own
 * `employee` + `attendance_record` and the three config tables; writes nothing.
 *
 * `attendance_record` holds exactly one OFFICE row per employee per day
 * (`uq_attendance_office_employee_day`) with `check_in` / `check_out` as `time`, so the adapter composes
 * the `'YYYY-MM-DD HH:mm:ss'` string the report contract expects directly in SQL — no aggregation is
 * needed, because the day IS the row. `loadDailyPunches` carries the full rationale for reading this
 * table rather than raw punches; read it before changing the source.
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
  UnreconciledDayRow,
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
      dayStatus: string | null;
    }> = await getManager(this.dataSource).query(
      // Reads `attendance_record` (mode OFFICE) — the RESOLVED daily truth that payroll and the
      // payslip also read (SRS §8). `/api/logs` keeps reading `checkin_log`; that is the punch
      // surface, and the two are deliberately different views (design §6.1).
      //
      // ── Why this changed back, and why it is safe now (do not revert this) ──────────────────
      // This adapter read `checkin_log` between 27/07/2026 and this commit, for a real reason:
      // reconciliation SKIPS any employee-day it cannot place (no project, no financial year, an
      // already-confirmed row), so `attendance_record` was full of holes and the summary reported
      // everyone Absent while the log view showed real punches. Reading punches was the correct
      // fix for THAT bug.
      //
      // What made punches wrong instead: office capture now writes a day that has a STATUS but no
      // TIMES (a PAID_LEAVE or ABSENT day — the two-branch rule, FR-HR-004). Such a day has no
      // punches at all, so a punch-sourced report renders it `Absent` — for a day payroll PAYS.
      // The report is the document HR reconciles a payslip against, so the two disagreed by
      // construction.
      //
      // The holes were closed first, which is what makes this safe rather than a revert:
      //   - evidence-first project resolution + the device default (#45) — days stop landing on
      //     no project at all;
      //   - `skippedReasons` surfaced on sync/import — a skip can no longer read as success;
      //   - and `loadUnreconciledDays` below, so a window that still contains skipped days SAYS SO
      //     instead of quietly showing Absent. That guard is the standing protection against the
      //     27/07 bug returning; if you are tempted to remove it, the bug comes back with it.
      //
      // `punchCount` is derived (0/1/2) rather than counted: this row is a resolved DAY, and the
      // real per-punch breakdown lives on `/api/logs`, which is exactly what it is for.
      `SELECT e.id::text                              AS "employeeId",
              to_char(a.attendance_date,'YYYY-MM-DD') AS "attendanceDate",
              CASE WHEN a.check_in IS NULL THEN NULL
                   ELSE to_char(a.attendance_date,'YYYY-MM-DD') || ' ' ||
                        to_char(a.check_in,'HH24:MI:SS') END  AS "checkInAt",
              CASE WHEN a.check_out IS NULL THEN NULL
                   ELSE to_char(a.attendance_date,'YYYY-MM-DD') || ' ' ||
                        to_char(a.check_out,'HH24:MI:SS') END AS "checkOutAt",
              ((a.check_in IS NOT NULL)::int
                 + (a.check_out IS NOT NULL AND a.check_out <> a.check_in)::int) AS "punchCount",
              a.day_status                            AS "dayStatus"
         FROM "attendance_record" a
         JOIN "employee" e
           ON e.company_id = a.company_id
          AND e.id = a.employee_id
          AND e.deleted_at IS NULL
        WHERE a.company_id = $1
          AND a.mode = 'OFFICE'
          AND a.attendance_date BETWEEN $2::date AND $3::date
          AND a.employee_id = ANY($4::uuid[])`,
      [companyId, startDateText, endDateText, [...employeeIds]],
    );

    return rows;
  }

  async loadUnreconciledDays(
    companyId: string,
    startDateText: string,
    endDateText: string,
  ): Promise<UnreconciledDayRow[]> {
    // A skipped day leaves no record of the skip — `reconcileDays` returns its reasons and nothing
    // persists them. The one durable signature is punches with no day row, so that is what this
    // detects, and the reason is re-derived from the SAME guards reconciliation applies, in the
    // same order (FR-HR-008a vocabulary; no fifth reason is invented).
    //
    // ALREADY_CONFIRMED is deliberately absent: that guard skips a day whose row already EXISTS, so
    // it can never produce a missing row and is unreachable from here.
    return getManager(this.dataSource).query(
      `SELECT p."userId", p."attendanceDate",
              CASE
                WHEN e."id" IS NULL THEN 'UNKNOWN_EMPLOYEE_CODE'
                WHEN NOT EXISTS (
                  SELECT 1 FROM "financial_year" fy
                   WHERE fy."company_id" = $1 AND fy."deleted_at" IS NULL
                     AND p."attendanceDate"::date BETWEEN fy."start_date" AND fy."end_date"
                ) THEN 'NO_FINANCIAL_YEAR'
                ELSE 'NO_PROJECT'
              END AS "reason"
         FROM (
           SELECT DISTINCT c."user_id" AS "userId",
                  substring(c."device_timestamp" from 1 for 10) AS "attendanceDate"
             FROM "checkin_log" c
            WHERE c."company_id" = $1
              AND c."device_timestamp" >= $2 AND c."device_timestamp" <= $3
         ) p
         LEFT JOIN "employee" e
           ON e."company_id" = $1 AND e."employee_code" = p."userId" AND e."deleted_at" IS NULL
         LEFT JOIN "attendance_record" a
           ON a."company_id" = $1 AND a."mode" = 'OFFICE'
          AND a."employee_id" = e."id"
          AND a."attendance_date" = p."attendanceDate"::date
        WHERE a."id" IS NULL
        ORDER BY p."userId", p."attendanceDate"`,
      [companyId, `${startDateText} 00:00:00`, `${endDateText} 23:59:59`],
    ) as Promise<UnreconciledDayRow[]>;
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
