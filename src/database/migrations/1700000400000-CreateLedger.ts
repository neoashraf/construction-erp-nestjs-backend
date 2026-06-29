import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LED ledger spine — `journal_entry` + `journal_line` with ALL DB-level integrity (FR-LED-001..024,
 * ADR-0002 F2). Raw SQL, `synchronize:false`. Belt-and-suspenders to the aggregate:
 *   - DEFERRED balance CONSTRAINT TRIGGER on journal_line: Σdebit = Σcredit per entry at COMMIT (AC2);
 *   - BEFORE UPDATE OR DELETE append-only trigger on both tables → RAISE (AC3);
 *   - journal_line CHECKs: debit>=0, credit>=0, exactly one side non-zero (AC4);
 *   - FKs ON DELETE RESTRICT (company/financial_year/journal_entry/reversal_of self-FK);
 *   - the §7 indexes. No status/is_reversed/deleted_at on journal_entry (AC14).
 *
 * NOTE: FKs on journal_line.account_id / project_id / cost_centre_id / purpose_id / godown_id /
 * party_id (and journal_entry.posted_by → user) are intentionally DEFERRED to later migrations — those
 * MAS/AUD tables are not built yet; references are validated at the app layer (MasterLookupService).
 */
export class CreateLedger1700000400000 implements MigrationInterface {
  name = 'CreateLedger1700000400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "journal_entry" (
        "id"                uuid PRIMARY KEY,
        "company_id"        uuid NOT NULL,
        "financial_year_id" uuid NOT NULL,
        "entry_no"          varchar NOT NULL,
        "voucher_type"      varchar NOT NULL,
        "voucher_date"      date NOT NULL,
        "source_type"       varchar NOT NULL,
        "source_id"         uuid NOT NULL,
        "is_reversal"       boolean NOT NULL DEFAULT false,
        "reversal_of"       uuid,
        "posted_at"         timestamptz NOT NULL,
        "posted_by"         uuid NOT NULL,
        "narration"         text,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_journal_entry_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_journal_entry_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_journal_entry_reversal_of"
          FOREIGN KEY ("reversal_of") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_journal_entry_company_fy" ON "journal_entry" ("company_id", "financial_year_id")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_entry_company_fy_date" ON "journal_entry" ("company_id", "financial_year_id", "voucher_date")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_entry_voucher_date" ON "journal_entry" ("voucher_date")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_entry_reversal_of" ON "journal_entry" ("reversal_of")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_entry_source" ON "journal_entry" ("source_type", "source_id")`);

    await queryRunner.query(`
      CREATE TABLE "journal_line" (
        "id"               uuid PRIMARY KEY,
        "journal_entry_id" uuid NOT NULL,
        "line_no"          integer NOT NULL,
        "account_id"       uuid NOT NULL,
        "project_id"       uuid,
        "cost_centre_id"   uuid,
        "purpose_id"       uuid,
        "godown_id"        uuid,
        "party_id"         uuid,
        "debit"            numeric(18,4) NOT NULL,
        "credit"           numeric(18,4) NOT NULL,
        "narration"        text,
        CONSTRAINT "fk_journal_line_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT,
        CONSTRAINT "chk_journal_line_debit_nonneg" CHECK ("debit" >= 0),
        CONSTRAINT "chk_journal_line_credit_nonneg" CHECK ("credit" >= 0),
        CONSTRAINT "chk_journal_line_one_side" CHECK (("debit" = 0) <> ("credit" = 0))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_journal_line_entry" ON "journal_line" ("journal_entry_id")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_line_account" ON "journal_line" ("account_id")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_line_project" ON "journal_line" ("project_id")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_line_cost_centre" ON "journal_line" ("cost_centre_id")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_line_purpose" ON "journal_line" ("purpose_id")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_line_godown" ON "journal_line" ("godown_id")`);
    await queryRunner.query(`CREATE INDEX "idx_journal_line_party" ON "journal_line" ("party_id")`);

    // Append-only: posted ledger rows are immutable at the storage layer (FR-LED-024).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ze_ledger_append_only() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_journal_entry_append_only"
        BEFORE UPDATE OR DELETE ON "journal_entry"
        FOR EACH ROW EXECUTE FUNCTION ze_ledger_append_only();
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_journal_line_append_only"
        BEFORE UPDATE OR DELETE ON "journal_line"
        FOR EACH ROW EXECUTE FUNCTION ze_ledger_append_only();
    `);

    // Deferred balance: Σdebit = Σcredit per entry, checked once at COMMIT (FR-LED-015).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ze_ledger_balance_check() RETURNS trigger AS $fn$
      DECLARE
        v_entry uuid;
        v_dr numeric(18,4);
        v_cr numeric(18,4);
      BEGIN
        v_entry := COALESCE(NEW."journal_entry_id", OLD."journal_entry_id");
        SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0)
          INTO v_dr, v_cr FROM "journal_line" WHERE "journal_entry_id" = v_entry;
        IF v_dr <> v_cr THEN
          RAISE EXCEPTION 'unbalanced journal entry %: debit % <> credit %', v_entry, v_dr, v_cr;
        END IF;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER "trg_journal_line_balance"
        AFTER INSERT ON "journal_line"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ze_ledger_balance_check();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "journal_line"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "journal_entry"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS ze_ledger_balance_check()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS ze_ledger_append_only()`);
  }
}
