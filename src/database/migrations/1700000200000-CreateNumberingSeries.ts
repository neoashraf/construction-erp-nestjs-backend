import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NUM counter — `numbering_series` (FR-NUM-001/002/003/005). Raw SQL, `synchronize:false`. The unit of
 * gaplessness: one row per (company, financial year, voucher type), incremented under SELECT … FOR
 * UPDATE inside the post transaction. Unique triple, CHECKs (padding_width >= 1, last_sequence >= 0),
 * FKs to company/financial_year ON DELETE RESTRICT. NO `deleted_at` — series rows persist permanently.
 */
export class CreateNumberingSeries1700000200000 implements MigrationInterface {
  name = 'CreateNumberingSeries1700000200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "numbering_series" (
        "id"                uuid PRIMARY KEY,
        "company_id"        uuid NOT NULL,
        "financial_year_id" uuid NOT NULL,
        "voucher_type"      varchar NOT NULL,
        "prefix"            varchar NOT NULL,
        "padding_width"     integer NOT NULL DEFAULT 4,
        "last_sequence"     integer NOT NULL DEFAULT 0,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        "created_by"        uuid,
        "updated_by"        uuid,
        "version"           integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_numbering_padding_width" CHECK ("padding_width" >= 1),
        CONSTRAINT "chk_numbering_last_sequence" CHECK ("last_sequence" >= 0),
        CONSTRAINT "fk_numbering_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_numbering_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT
      )
    `);
    // Series identity + the access path for the FOR UPDATE point lookup (FR-NUM-001).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_numbering_series_triple"
         ON "numbering_series" ("company_id", "financial_year_id", "voucher_type")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "numbering_series"`);
  }
}
