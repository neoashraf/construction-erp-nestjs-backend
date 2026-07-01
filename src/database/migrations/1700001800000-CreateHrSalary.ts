import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HR office-staff payroll tables (FR-HR-013..018, brief #38 hr-payroll-salary-accrual). Raw SQL,
 * `synchronize:false`. Creates the THREE new HR-owned tables — NO ledger object (the ledger + its
 * balance/append-only triggers are LED's, already shipped; HR's SALARY posting flows through
 * PostingService into the EXISTING `journal_entry`/`journal_line`). Does NOT touch
 * `1700001300000-CreateHrEmployeeAttendance.ts` (already shipped) — employee/attendance/labour_payable are
 * untouched.
 *
 *   1. salary_sheet        — the per-period payroll run; status DRAFT|POSTED ONLY (app-checked varchar —
 *                            'REVERSED' is NEVER stored, design §3: it is derived from whether a
 *                            journal_entry with reversal_of = salary_entry_id exists); the draft-unique
 *                            PARTIAL index (one DRAFT per company+FY+period — edge §12.4); salary_entry_id
 *                            FK -> journal_entry, null while DRAFT.
 *   2. salary_sheet_line    — one row per employee per sheet (also the payslip data — FR-HR-017); money
 *                            numeric(18,4); FKs to employee/project/cost_centre/purpose + the parent sheet.
 *   3. hr_account_config    — the company-scoped role -> account/cost-centre mapping HrAccountResolverAdapter
 *                            reads to resolve the six SALARY posting accounts + the Labour cost centre
 *                            (architectural decision 3/4) — NOT seeded here (seeded at go-live, a
 *                            deployment concern per the brief's own note); exactly one of account_id /
 *                            cost_centre_id is set per row (a CHECK below).
 *
 * All FKs ON DELETE RESTRICT (a referenced master / ledger entry can never be hard-deleted out from under
 * an HR row) — mirrors journal_line -> journal_entry's own RESTRICT convention. HR adds NO index/trigger to
 * `journal_line` — the posted ledger is LED's.
 */
export class CreateHrSalary1700001800000 implements MigrationInterface {
  name = 'CreateHrSalary1700001800000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- salary_sheet -----------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "salary_sheet" (
        "id"                 uuid PRIMARY KEY,
        "company_id"         uuid NOT NULL,
        "financial_year_id"  uuid NOT NULL,
        "period_label"       varchar NOT NULL,
        "period_start"       date NOT NULL,
        "period_end"         date NOT NULL,
        "status"             varchar NOT NULL DEFAULT 'DRAFT',
        "salary_entry_id"    uuid,
        "posted_at"          timestamptz,
        "posted_by"          uuid,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now(),
        "created_by"         uuid,
        "updated_by"         uuid,
        "version"            integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_salary_sheet_status"
          CHECK ("status" IN ('DRAFT','POSTED')),
        CONSTRAINT "chk_salary_sheet_period"
          CHECK ("period_end" >= "period_start"),
        CONSTRAINT "fk_salary_sheet_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_salary_sheet_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_salary_sheet_journal_entry"
          FOREIGN KEY ("salary_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);
    // One DRAFT per (company, FY, period) — edge §12.4 / API DUPLICATE_DRAFT_SHEET.
    await q.query(`
      CREATE UNIQUE INDEX "uq_salary_sheet_draft_period"
        ON "salary_sheet" ("company_id", "financial_year_id", "period_label")
        WHERE "status" = 'DRAFT'
    `);
    await q.query(
      `CREATE INDEX "idx_salary_sheet_company_fy_period" ON "salary_sheet" ("company_id", "financial_year_id", "period_label")`,
    );
    await q.query(`CREATE INDEX "idx_salary_sheet_journal_entry" ON "salary_sheet" ("salary_entry_id")`);

    // ---- salary_sheet_line -------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "salary_sheet_line" (
        "id"                uuid PRIMARY KEY,
        "salary_sheet_id"   uuid NOT NULL,
        "employee_id"       uuid NOT NULL,
        "project_id"        uuid NOT NULL,
        "cost_centre_id"    uuid NOT NULL,
        "purpose_id"        uuid NOT NULL,
        "paid_days"         numeric(18,4) NOT NULL DEFAULT 0,
        "gross_amount"      numeric(18,4) NOT NULL DEFAULT 0,
        "allowances"        numeric(18,4) NOT NULL DEFAULT 0,
        "tds"               numeric(18,4) NOT NULL DEFAULT 0,
        "pf"                numeric(18,4) NOT NULL DEFAULT 0,
        "advance_recovery"  numeric(18,4) NOT NULL DEFAULT 0,
        "other_deductions"  numeric(18,4) NOT NULL DEFAULT 0,
        "net_amount"        numeric(18,4) NOT NULL DEFAULT 0,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        "created_by"        uuid,
        "updated_by"        uuid,
        "version"           integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_salary_sheet_line_nonneg"
          CHECK ("paid_days" >= 0 AND "gross_amount" >= 0 AND "allowances" >= 0 AND "tds" >= 0
             AND "pf" >= 0 AND "advance_recovery" >= 0 AND "other_deductions" >= 0),
        CONSTRAINT "fk_salary_sheet_line_sheet"
          FOREIGN KEY ("salary_sheet_id") REFERENCES "salary_sheet" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_salary_sheet_line_employee"
          FOREIGN KEY ("employee_id") REFERENCES "employee" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_salary_sheet_line_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_salary_sheet_line_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_salary_sheet_line_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_salary_sheet_line_sheet" ON "salary_sheet_line" ("salary_sheet_id")`);
    await q.query(`CREATE INDEX "idx_salary_sheet_line_employee" ON "salary_sheet_line" ("employee_id")`);

    // ---- hr_account_config --------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "hr_account_config" (
        "id"              uuid PRIMARY KEY,
        "company_id"      uuid NOT NULL,
        "role"            varchar NOT NULL,
        "account_id"      uuid,
        "cost_centre_id"  uuid,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_hr_account_config_role"
          CHECK ("role" IN ('GROSS_SALARY','EMPLOYER_PF','SALARY_PAYABLE','TDS_PAYABLE','PF_PAYABLE',
                             'STAFF_ADVANCE_RECOVERY','LABOUR_COST_CENTRE')),
        CONSTRAINT "chk_hr_account_config_exactly_one"
          CHECK ((("account_id" IS NOT NULL)::int + ("cost_centre_id" IS NOT NULL)::int) = 1),
        CONSTRAINT "fk_hr_account_config_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_hr_account_config_account"
          FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_hr_account_config_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX "uq_hr_account_config_company_role" ON "hr_account_config" ("company_id", "role")`,
    );
    // NOTE: intentionally NOT seeded here — the role->account mapping is configured at go-live (brief's
    // own Scope note); integration tests insert their own rows for the test company.
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "hr_account_config"`);
    await q.query(`DROP TABLE IF EXISTS "salary_sheet_line"`);
    await q.query(`DROP TABLE IF EXISTS "salary_sheet"`);
  }
}
