import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PER temporal gate — `accounting_period` (FR-PER-001..010). Raw SQL, `synchronize:false`. One row per
 * (company, FY) month, OPEN/CLOSED. Enforces:
 *   - UNIQUE (company, FY, name) and (company, FY, start_date) — no duplicate months/starts (FR-PER-004);
 *   - EXCLUDE USING gist non-overlap on the inclusive daterange, scoped by tenant (needs btree_gist);
 *   - CHECK end_date >= start_date;
 *   - FKs company/financial_year ON DELETE RESTRICT (closed_by → user FK is added when AUD lands);
 *   - the (company, FY, start_date) date-lookup index for the post-time guard hot path.
 * No `deleted_at`; `version` for optimistic locking on close/reopen.
 */
export class CreateAccountingPeriod1700000300000 implements MigrationInterface {
  name = 'CreateAccountingPeriod1700000300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await queryRunner.query(`
      CREATE TABLE "accounting_period" (
        "id"                uuid PRIMARY KEY,
        "company_id"        uuid NOT NULL,
        "financial_year_id" uuid NOT NULL,
        "name"              varchar NOT NULL,
        "start_date"        date NOT NULL,
        "end_date"          date NOT NULL,
        "status"            varchar NOT NULL DEFAULT 'OPEN',
        "closed_at"         timestamptz,
        "closed_by"         uuid,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        "version"           integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_accounting_period_date_range" CHECK ("end_date" >= "start_date"),
        CONSTRAINT "uq_accounting_period_name" UNIQUE ("company_id", "financial_year_id", "name"),
        CONSTRAINT "uq_accounting_period_start" UNIQUE ("company_id", "financial_year_id", "start_date"),
        CONSTRAINT "fk_accounting_period_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_accounting_period_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "excl_accounting_period_overlap" EXCLUDE USING gist (
          "company_id" WITH =,
          "financial_year_id" WITH =,
          daterange("start_date", "end_date", '[]') WITH &&
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_accounting_period_lookup"
         ON "accounting_period" ("company_id", "financial_year_id", "start_date")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "accounting_period"`);
  }
}
