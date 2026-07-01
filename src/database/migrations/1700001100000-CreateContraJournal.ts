import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GEN contra & journal DRAFT tables (FR-GEN-001..020, brief #15). Raw SQL, `synchronize:false`. Creates
 * the four GEN-owned draft tables — `contra_voucher` + `contra_line`, `journal_voucher` +
 * `journal_line_draft` (named to avoid colliding with LED's posted `journal_line`) — with:
 *   - line-side CHECKs: debit>=0, credit>=0, exactly one side non-zero (mirrors LED FR-LED-008);
 *   - status app-checked varchar (DRAFT|POSTED|CANCELLED); voucher_type app-checked varchar (no DB enum);
 *   - journal_entry_id FK → LED `journal_entry` (ON DELETE RESTRICT), null while DRAFT, set at post;
 *   - FKs ON DELETE RESTRICT to company/financial_year/account/dimensions/party (a referenced master or
 *     ledger entry can never be hard-deleted out from under a draft);
 *   - the PARTIAL UNIQUE index one-opening-per-company:
 *       UNIQUE (company_id) WHERE voucher_type='OPENING' AND deleted_at IS NULL   (FR-GEN-012);
 *   - the §7 list indexes.
 * GEN adds NO index/trigger to `journal_line` — the posted ledger is LED's. No change to LED's migration.
 */
export class CreateContraJournal1700001100000 implements MigrationInterface {
  name = 'CreateContraJournal1700001100000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- contra_voucher --------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "contra_voucher" (
        "id"                uuid PRIMARY KEY,
        "company_id"        uuid NOT NULL,
        "financial_year_id" uuid NOT NULL,
        "voucher_date"      date NOT NULL,
        "narration"         text,
        "status"            varchar NOT NULL DEFAULT 'DRAFT',
        "entry_no"          varchar,
        "journal_entry_id"  uuid,
        "posted_at"         timestamptz,
        "posted_by"         uuid,
        "deleted_at"        timestamptz,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        "created_by"        uuid,
        "updated_by"        uuid,
        "version"           integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_contra_voucher_status" CHECK ("status" IN ('DRAFT','POSTED','CANCELLED')),
        CONSTRAINT "fk_contra_voucher_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_contra_voucher_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_contra_voucher_journal_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_contra_voucher_company_status" ON "contra_voucher" ("company_id", "status")`);
    await q.query(`CREATE INDEX "idx_contra_voucher_company_date" ON "contra_voucher" ("company_id", "voucher_date")`);
    await q.query(`CREATE INDEX "idx_contra_voucher_entry_no" ON "contra_voucher" ("entry_no")`);

    await q.query(`
      CREATE TABLE "contra_line" (
        "id"                uuid PRIMARY KEY,
        "contra_voucher_id" uuid NOT NULL,
        "line_no"           integer NOT NULL,
        "account_id"        uuid NOT NULL,
        "debit"             numeric(18,4) NOT NULL DEFAULT 0,
        "credit"            numeric(18,4) NOT NULL DEFAULT 0,
        "narration"         text,
        CONSTRAINT "chk_contra_line_debit_nonneg"  CHECK ("debit" >= 0),
        CONSTRAINT "chk_contra_line_credit_nonneg" CHECK ("credit" >= 0),
        CONSTRAINT "chk_contra_line_one_side"      CHECK (("debit" = 0) <> ("credit" = 0)),
        CONSTRAINT "fk_contra_line_voucher"
          FOREIGN KEY ("contra_voucher_id") REFERENCES "contra_voucher" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_contra_line_account"
          FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_contra_line_voucher" ON "contra_line" ("contra_voucher_id")`);

    // ---- journal_voucher -------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "journal_voucher" (
        "id"                uuid PRIMARY KEY,
        "company_id"        uuid NOT NULL,
        "financial_year_id" uuid NOT NULL,
        "voucher_type"      varchar NOT NULL DEFAULT 'JOURNAL',
        "voucher_date"      date NOT NULL,
        "narration"         text,
        "status"            varchar NOT NULL DEFAULT 'DRAFT',
        "entry_no"          varchar,
        "journal_entry_id"  uuid,
        "posted_at"         timestamptz,
        "posted_by"         uuid,
        "deleted_at"        timestamptz,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        "created_by"        uuid,
        "updated_by"        uuid,
        "version"           integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_journal_voucher_status" CHECK ("status" IN ('DRAFT','POSTED','CANCELLED')),
        CONSTRAINT "chk_journal_voucher_type"   CHECK ("voucher_type" IN ('JOURNAL','OPENING')),
        CONSTRAINT "fk_journal_voucher_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_journal_voucher_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_journal_voucher_journal_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_journal_voucher_company_status" ON "journal_voucher" ("company_id", "status")`);
    await q.query(`CREATE INDEX "idx_journal_voucher_company_date" ON "journal_voucher" ("company_id", "voucher_date")`);
    await q.query(`CREATE INDEX "idx_journal_voucher_entry_no" ON "journal_voucher" ("entry_no")`);
    // One opening journal per company (FR-GEN-012) — backs existsOpeningFor at the DB level.
    await q.query(`
      CREATE UNIQUE INDEX "uq_journal_voucher_one_opening"
        ON "journal_voucher" ("company_id")
        WHERE "voucher_type" = 'OPENING' AND "deleted_at" IS NULL
    `);

    await q.query(`
      CREATE TABLE "journal_line_draft" (
        "id"                 uuid PRIMARY KEY,
        "journal_voucher_id" uuid NOT NULL,
        "line_no"            integer NOT NULL,
        "account_id"         uuid NOT NULL,
        "project_id"         uuid,
        "cost_centre_id"     uuid,
        "purpose_id"         uuid,
        "party_id"           uuid,
        "account_type"       varchar,
        "is_control_account" boolean NOT NULL DEFAULT false,
        "debit"              numeric(18,4) NOT NULL DEFAULT 0,
        "credit"             numeric(18,4) NOT NULL DEFAULT 0,
        "narration"          text,
        CONSTRAINT "chk_journal_line_draft_debit_nonneg"  CHECK ("debit" >= 0),
        CONSTRAINT "chk_journal_line_draft_credit_nonneg" CHECK ("credit" >= 0),
        CONSTRAINT "chk_journal_line_draft_one_side"      CHECK (("debit" = 0) <> ("credit" = 0)),
        CONSTRAINT "fk_journal_line_draft_voucher"
          FOREIGN KEY ("journal_voucher_id") REFERENCES "journal_voucher" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_journal_line_draft_account"
          FOREIGN KEY ("account_id") REFERENCES "account" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_journal_line_draft_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_journal_line_draft_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_journal_line_draft_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_journal_line_draft_party"
          FOREIGN KEY ("party_id") REFERENCES "party" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_journal_line_draft_voucher" ON "journal_line_draft" ("journal_voucher_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "journal_line_draft"`);
    await q.query(`DROP TABLE IF EXISTS "journal_voucher"`);
    await q.query(`DROP TABLE IF EXISTS "contra_line"`);
    await q.query(`DROP TABLE IF EXISTS "contra_voucher"`);
  }
}
