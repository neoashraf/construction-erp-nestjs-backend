import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The late-count penalty and the day figures behind FR-HR-013a.
 *
 * `attendance_setting.lates_per_deducted_day` joins the late THRESHOLD already on that row, so the
 * attendance report and the salary sheet read the same per-company configuration and can never
 * disagree about which days were late, or about how many lates cost a day (FR-HR-008c).
 *
 * The five `salary_sheet_line` columns are STORED, not recomputed at render. FR-HR-013a needs a
 * per-employee unpaid-day count before posting, and the payslip must explain its own deduction —
 * recomputing either from attendance at render time re-reads a period that may have changed since
 * the sheet was posted. The line stays self-contained: everything needed to explain the figure is on
 * the row. Defaults are 0 so runs posted BEFORE this migration keep reading, with no penalty story
 * they never computed.
 *
 * `salary_sheet.pre_post_warnings` lives on the SHEET, not the line — the warnings are about the run
 * as a whole (days nobody recorded, employees skipped, no weekly holidays configured). `jsonb`
 * because the collections are display-only evidence read back whole with the sheet: never queried,
 * aggregated or joined across sheets, so child tables would buy queryability nothing needs and cost
 * four joins on every sheet read. Nullable, because a sheet generated before this column existed
 * genuinely has no warnings — as distinct from a run that computed them and found none.
 */
export class AddLatePenalty1785000000000 implements MigrationInterface {
  name = 'AddLatePenalty1785000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "attendance_setting"
         ADD COLUMN "lates_per_deducted_day" integer NOT NULL DEFAULT 3`,
    );
    // >= 1: zero would divide by zero in `penaltyDays`, and a negative is meaningless.
    await q.query(
      `ALTER TABLE "attendance_setting"
         ADD CONSTRAINT "chk_attendance_setting_lates" CHECK ("lates_per_deducted_day" >= 1)`,
    );

    await q.query(
      `ALTER TABLE "salary_sheet_line"
         ADD COLUMN "late_count"          integer       NOT NULL DEFAULT 0,
         ADD COLUMN "late_penalty_days"   numeric(18,4) NOT NULL DEFAULT 0,
         ADD COLUMN "late_penalty_amount" numeric(18,4) NOT NULL DEFAULT 0,
         ADD COLUMN "standard_days"       numeric(18,4) NOT NULL DEFAULT 0,
         ADD COLUMN "unpaid_days"         numeric(18,4) NOT NULL DEFAULT 0`,
    );
    await q.query(
      `ALTER TABLE "salary_sheet_line"
         ADD CONSTRAINT "chk_salary_sheet_line_days_nonneg"
         CHECK ("late_count" >= 0 AND "late_penalty_days" >= 0 AND "late_penalty_amount" >= 0
            AND "standard_days" >= 0 AND "unpaid_days" >= 0)`,
    );

    await q.query(`ALTER TABLE "salary_sheet" ADD COLUMN "pre_post_warnings" jsonb`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "salary_sheet" DROP COLUMN IF EXISTS "pre_post_warnings"`);
    await q.query(
      `ALTER TABLE "salary_sheet_line"
         DROP CONSTRAINT IF EXISTS "chk_salary_sheet_line_days_nonneg"`,
    );
    await q.query(
      `ALTER TABLE "salary_sheet_line"
         DROP COLUMN IF EXISTS "unpaid_days",
         DROP COLUMN IF EXISTS "standard_days",
         DROP COLUMN IF EXISTS "late_penalty_amount",
         DROP COLUMN IF EXISTS "late_penalty_days",
         DROP COLUMN IF EXISTS "late_count"`,
    );
    await q.query(
      `ALTER TABLE "attendance_setting" DROP CONSTRAINT IF EXISTS "chk_attendance_setting_lates"`,
    );
    await q.query(
      `ALTER TABLE "attendance_setting" DROP COLUMN IF EXISTS "lates_per_deducted_day"`,
    );
  }
}
