import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Configuration tables the attendance reports (`/api/reports/{daily,range,summary}`) read
 * (REPORTS_MODULE_GUIDE §2). The punch data itself is NOT created here — the reports read HR's existing
 * `attendance_record` (mode = OFFICE) and `employee`, so attendance keeps exactly ONE owner (CLAUDE.md
 * "one owner per entity"). Only the three settings tables the source project also needed are added:
 *
 *   1. attendance_setting  — the late cut-off; one row per company (the source project's singleton
 *                            `id = 1` becomes a per-company unique, this platform being multi-company).
 *   2. weekly_holiday      — recurring weekend days, 0 = Sunday … 6 = Saturday, unique per company.
 *   3. government_holiday  — dated public holidays; overrides weekly holidays in the report (§3.3).
 *
 * `government_holiday.date` is a real `date` (not the source project's TEXT) because everything it is
 * compared against here — `attendance_record.attendance_date` — is already a `date`; the read adapter
 * casts to `'YYYY-MM-DD'` text at the edge, so the JSON is byte-identical. All FKs ON DELETE RESTRICT.
 * No row is seeded: with no `attendance_setting` row the reports fall back to 09:30, and with no holiday
 * rows every day in the window counts as a working day.
 */
export class CreateAttendanceReportConfig1784700000000 implements MigrationInterface {
  name = 'CreateAttendanceReportConfig1784700000000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- attendance_setting (late threshold, one row per company) --------------------------------
    await q.query(`
      CREATE TABLE "attendance_setting" (
        "id"                uuid PRIMARY KEY,
        "company_id"        uuid NOT NULL,
        "late_after_hour"   integer NOT NULL DEFAULT 9,
        "late_after_minute" integer NOT NULL DEFAULT 30,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_attendance_setting_company" UNIQUE ("company_id"),
        CONSTRAINT "chk_attendance_setting_hour"
          CHECK ("late_after_hour" >= 0 AND "late_after_hour" <= 23),
        CONSTRAINT "chk_attendance_setting_minute"
          CHECK ("late_after_minute" >= 0 AND "late_after_minute" <= 59),
        CONSTRAINT "fk_attendance_setting_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT
      )
    `);

    // ---- weekly_holiday (0 = Sunday … 6 = Saturday) ----------------------------------------------
    await q.query(`
      CREATE TABLE "weekly_holiday" (
        "id"         uuid PRIMARY KEY,
        "company_id" uuid NOT NULL,
        "weekday"    integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_weekly_holiday_company_weekday" UNIQUE ("company_id", "weekday"),
        CONSTRAINT "chk_weekly_holiday_weekday" CHECK ("weekday" >= 0 AND "weekday" <= 6),
        CONSTRAINT "fk_weekly_holiday_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT
      )
    `);

    // ---- government_holiday (dated; beats weekly in the report) -----------------------------------
    await q.query(`
      CREATE TABLE "government_holiday" (
        "id"         uuid PRIMARY KEY,
        "company_id" uuid NOT NULL,
        "date"       date NOT NULL,
        "name"       varchar NOT NULL,
        "local_name" varchar,
        "source"     varchar NOT NULL DEFAULT 'import',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_government_holiday_company_date" UNIQUE ("company_id", "date"),
        CONSTRAINT "chk_government_holiday_source" CHECK ("source" IN ('import','manual')),
        CONSTRAINT "fk_government_holiday_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_government_holiday_company_date" ON "government_holiday" ("company_id", "date")`,
    );

    // The punch scan is `company_id + mode + attendance_date` over `attendance_record`, filtered to a
    // set of employees. `idx_attendance_company_date_mode` (shipped with the HR tables) already leads
    // with those three columns; this partial index adds the employee_id lookup for the OFFICE subset so
    // a month-wide report for a few employees stays an index scan.
    await q.query(`
      CREATE INDEX "idx_attendance_office_employee_date"
        ON "attendance_record" ("company_id", "employee_id", "attendance_date")
        WHERE "mode" = 'OFFICE'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_attendance_office_employee_date"`);
    await q.query(`DROP TABLE IF EXISTS "government_holiday"`);
    await q.query(`DROP TABLE IF EXISTS "weekly_holiday"`);
    await q.query(`DROP TABLE IF EXISTS "attendance_setting"`);
  }
}
