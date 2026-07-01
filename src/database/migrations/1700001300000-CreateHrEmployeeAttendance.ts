import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HR people-and-attendance tables (FR-HR-001..012, brief #17). Raw SQL, `synchronize:false`. Creates the
 * four HR-owned tables — NO ledger object (the ledger + its balance/append-only triggers are LED's,
 * already shipped; HR's accrual posts through PostingService into `journal_entry`/`journal_line`). Salary
 * sheets/payslips are the sibling salary-accrual brief and are NOT created here.
 *
 *   1. employee              — office staff only; (company_id, employee_code) unique (non-deleted); wage
 *                              numeric(18,4); wage_amount>=0 + status CHECKs; sensitive bank/TIN columns.
 *   2. employee_assignment   — append-only reassignment history (no version / no soft delete — immutable).
 *   3. attendance_record     — the mode discriminator + per-mode CHECKs; OFFICE partial-unique (one row per
 *                              employee per day); is_confirmed↔accrual_entry_id guard; accrual_entry_id FK.
 *   4. labour_payable        — accrued/settled amounts + accrual_entry_id FK + derived status.
 *
 * All FKs ON DELETE RESTRICT (a referenced master / ledger entry can never be hard-deleted out from under
 * an HR row). HR adds NO index/trigger to `journal_line` — the posted ledger is LED's.
 */
export class CreateHrEmployeeAttendance1700001300000 implements MigrationInterface {
  name = 'CreateHrEmployeeAttendance1700001300000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- employee -------------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "employee" (
        "id"                   uuid PRIMARY KEY,
        "company_id"           uuid NOT NULL,
        "employee_code"        varchar NOT NULL,
        "name"                 varchar NOT NULL,
        "designation"          varchar NOT NULL,
        "default_project_id"   uuid,
        "department"           varchar,
        "work_base"            varchar NOT NULL,
        "wage_type"            varchar NOT NULL,
        "wage_amount"          numeric(18,4) NOT NULL DEFAULT 0,
        "bank_account_name"    varchar,
        "bank_account_no"      varchar,
        "bank_name"            varchar,
        "pf_applicable"        boolean NOT NULL DEFAULT false,
        "gratuity_applicable"  boolean NOT NULL DEFAULT false,
        "wppf_applicable"      boolean NOT NULL DEFAULT false,
        "tin"                  varchar,
        "joining_date"         date NOT NULL,
        "status"               varchar NOT NULL DEFAULT 'ACTIVE',
        "deleted_at"           timestamptz,
        "created_at"           timestamptz NOT NULL DEFAULT now(),
        "updated_at"           timestamptz NOT NULL DEFAULT now(),
        "created_by"           uuid,
        "updated_by"           uuid,
        "version"              integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_employee_status"     CHECK ("status" IN ('ACTIVE','INACTIVE')),
        CONSTRAINT "chk_employee_wage_type"  CHECK ("wage_type" IN ('MONTHLY','DAILY')),
        CONSTRAINT "chk_employee_work_base"  CHECK ("work_base" IN ('HEAD_OFFICE','SITE')),
        CONSTRAINT "chk_employee_wage_nonneg" CHECK ("wage_amount" >= 0),
        CONSTRAINT "fk_employee_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_employee_project"
          FOREIGN KEY ("default_project_id") REFERENCES "project" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`
      CREATE UNIQUE INDEX "uq_employee_company_code"
        ON "employee" ("company_id", "employee_code") WHERE "deleted_at" IS NULL
    `);
    await q.query(`CREATE INDEX "idx_employee_company_status" ON "employee" ("company_id", "status")`);
    await q.query(
      `CREATE INDEX "idx_employee_company_project" ON "employee" ("company_id", "default_project_id")`,
    );

    // ---- employee_assignment (append-only) ------------------------------------------------------
    await q.query(`
      CREATE TABLE "employee_assignment" (
        "id"             uuid PRIMARY KEY,
        "employee_id"    uuid NOT NULL,
        "company_id"     uuid NOT NULL,
        "project_id"     uuid NOT NULL,
        "effective_date" date NOT NULL,
        "note"           text,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "created_by"     uuid,
        CONSTRAINT "fk_employee_assignment_employee"
          FOREIGN KEY ("employee_id") REFERENCES "employee" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_employee_assignment_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_employee_assignment_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_employee_assignment_employee_date" ON "employee_assignment" ("employee_id", "effective_date")`,
    );

    // ---- attendance_record (three modes) --------------------------------------------------------
    await q.query(`
      CREATE TABLE "attendance_record" (
        "id"                 uuid PRIMARY KEY,
        "company_id"         uuid NOT NULL,
        "financial_year_id"  uuid NOT NULL,
        "mode"               varchar NOT NULL,
        "attendance_date"    date NOT NULL,
        "project_id"         uuid NOT NULL,
        "cost_centre_id"     uuid,
        "purpose_id"         uuid,
        "employee_id"        uuid,
        "check_in"           time,
        "check_out"          time,
        "day_status"         varchar,
        "overtime_hours"     numeric(18,4),
        "party_id"           uuid,
        "head_count"         integer,
        "labour_category"    varchar,
        "daily_rate"         numeric(18,4),
        "source"             varchar NOT NULL DEFAULT 'MANUAL',
        "is_confirmed"       boolean NOT NULL DEFAULT false,
        "accrual_entry_id"   uuid,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now(),
        "created_by"         uuid,
        "updated_by"         uuid,
        "version"            integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_attendance_mode"
          CHECK ("mode" IN ('OFFICE','SUBCONTRACTOR','DAILY_LABOUR')),
        CONSTRAINT "chk_attendance_source"
          CHECK ("source" IN ('MANUAL','BIOMETRIC_IMPORT')),
        CONSTRAINT "chk_attendance_day_status"
          CHECK ("day_status" IS NULL OR "day_status" IN ('PRESENT','PAID_LEAVE','UNPAID_LEAVE','ABSENT')),
        -- per-mode required fields (SRS §11; design §7)
        CONSTRAINT "chk_attendance_office"
          CHECK ("mode" <> 'OFFICE' OR ("employee_id" IS NOT NULL AND "head_count" IS NULL AND "party_id" IS NULL)),
        CONSTRAINT "chk_attendance_subcontractor"
          CHECK ("mode" <> 'SUBCONTRACTOR' OR ("party_id" IS NOT NULL AND "cost_centre_id" IS NOT NULL AND "head_count" >= 1)),
        CONSTRAINT "chk_attendance_daily_labour"
          CHECK ("mode" <> 'DAILY_LABOUR' OR ("cost_centre_id" IS NOT NULL AND "head_count" >= 1 AND "daily_rate" >= 0)),
        -- is_confirmed only flips with an accrual entry, and only DAILY_LABOUR ever confirms
        CONSTRAINT "chk_attendance_confirmed_entry"
          CHECK (("is_confirmed" = false AND "accrual_entry_id" IS NULL)
              OR ("is_confirmed" = true AND "accrual_entry_id" IS NOT NULL AND "mode" = 'DAILY_LABOUR')),
        CONSTRAINT "fk_attendance_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_attendance_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_attendance_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_attendance_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_attendance_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_attendance_employee"
          FOREIGN KEY ("employee_id") REFERENCES "employee" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_attendance_party"
          FOREIGN KEY ("party_id") REFERENCES "party" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_attendance_accrual_entry"
          FOREIGN KEY ("accrual_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);
    // One OFFICE row per employee per day (edge §12.9 reconciliation).
    await q.query(`
      CREATE UNIQUE INDEX "uq_attendance_office_employee_day"
        ON "attendance_record" ("company_id", "employee_id", "attendance_date")
        WHERE "mode" = 'OFFICE'
    `);
    await q.query(
      `CREATE INDEX "idx_attendance_company_date_mode" ON "attendance_record" ("company_id", "attendance_date", "mode")`,
    );
    await q.query(
      `CREATE INDEX "idx_attendance_project_cc_date" ON "attendance_record" ("project_id", "cost_centre_id", "attendance_date")`,
    );
    await q.query(
      `CREATE INDEX "idx_attendance_accrual_entry" ON "attendance_record" ("accrual_entry_id")`,
    );

    // ---- labour_payable -------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "labour_payable" (
        "id"                uuid PRIMARY KEY,
        "company_id"        uuid NOT NULL,
        "financial_year_id" uuid NOT NULL,
        "project_id"        uuid NOT NULL,
        "cost_centre_id"    uuid NOT NULL,
        "accrual_date"      date NOT NULL,
        "accrued_amount"    numeric(18,4) NOT NULL,
        "accrual_entry_id"  uuid NOT NULL,
        "settled_amount"    numeric(18,4) NOT NULL DEFAULT 0,
        "status"            varchar NOT NULL DEFAULT 'OUTSTANDING',
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        "created_by"        uuid,
        "updated_by"        uuid,
        "version"           integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_labour_payable_status"
          CHECK ("status" IN ('OUTSTANDING','PARTIALLY_SETTLED','SETTLED')),
        CONSTRAINT "chk_labour_payable_settled"
          CHECK ("settled_amount" >= 0 AND "settled_amount" <= "accrued_amount"),
        CONSTRAINT "fk_labour_payable_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_labour_payable_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_labour_payable_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_labour_payable_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_labour_payable_accrual_entry"
          FOREIGN KEY ("accrual_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_labour_payable_company_project" ON "labour_payable" ("company_id", "project_id")`,
    );
    await q.query(
      `CREATE INDEX "idx_labour_payable_accrual_entry" ON "labour_payable" ("accrual_entry_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "labour_payable"`);
    await q.query(`DROP TABLE IF EXISTS "attendance_record"`);
    await q.query(`DROP TABLE IF EXISTS "employee_assignment"`);
    await q.query(`DROP TABLE IF EXISTS "employee"`);
  }
}
