import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MAS organisation masters — `company` + `financial_year` (FR-MAS-001..004). Raw SQL (skill §11,
 * ADR-0002 F2), `synchronize:false`. Establishes:
 *   - `company` (tenant root; no `company_id` of its own), with localization defaults + `version`.
 *   - `financial_year`, company-scoped, FK → company `ON DELETE RESTRICT`, `end_date > start_date`
 *     CHECK, and the `(company_id) WHERE is_active` PARTIAL-UNIQUE index enforcing at most one active
 *     financial year per company (FR-MAS-003).
 * `numbering_series` (NUM) and other MAS masters FK to `company`/`financial_year` in later migrations.
 */
export class CreateCompanyFinancialYear1700000100000 implements MigrationInterface {
  name = 'CreateCompanyFinancialYear1700000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "company" (
        "id"          uuid PRIMARY KEY,
        "name"        varchar NOT NULL,
        "legal_name"  varchar NOT NULL,
        "bin"         varchar NOT NULL,
        "tin"         varchar NOT NULL,
        "address"     text,
        "currency"    varchar NOT NULL DEFAULT 'BDT',
        "date_format" varchar NOT NULL DEFAULT 'DD/MM/YYYY',
        "locale"      varchar NOT NULL DEFAULT 'bn-BD',
        "is_active"   boolean NOT NULL DEFAULT true,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "deleted_at"  timestamptz,
        "created_by"  uuid,
        "updated_by"  uuid,
        "version"     integer NOT NULL DEFAULT 1
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "financial_year" (
        "id"          uuid PRIMARY KEY,
        "company_id"  uuid NOT NULL,
        "label"       varchar NOT NULL,
        "start_date"  date NOT NULL,
        "end_date"    date NOT NULL,
        "is_active"   boolean NOT NULL DEFAULT false,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "deleted_at"  timestamptz,
        "created_by"  uuid,
        "updated_by"  uuid,
        "version"     integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_financial_year_date_range" CHECK ("end_date" > "start_date"),
        CONSTRAINT "fk_financial_year_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_financial_year_company" ON "financial_year" ("company_id")`,
    );
    // At most ONE active financial year per company (FR-MAS-003).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_financial_year_active_per_company" ON "financial_year" ("company_id") WHERE "is_active"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "financial_year"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "company"`);
  }
}
