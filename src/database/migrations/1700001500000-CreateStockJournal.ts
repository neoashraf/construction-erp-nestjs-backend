import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * INV Stock Journal voucher tables (FR-INV-007..022, brief 2 of 3). Raw SQL, `synchronize:false`. Does
 * NOT touch `1700001000000-CreateStockMovementAndBalance.ts` (already shipped, brief 1) — this migration
 * only adds the voucher's own tables:
 *   1. stock_journal       — the header. status/mode app-checked varchar (adding a value = code, not
 *                            ALTER TYPE); entry_no nullable (null while draft/approved, and for a
 *                            value-neutral same-account transfer even once posted — design §4.2);
 *                            journal_entry_id nullable FK to LED journal_entry; quantity numeric(18,4);
 *                            rate/value nullable numeric(18,4) (set only at post); the §7 list indexes;
 *                            @VersionColumn; dimension FKs ON DELETE RESTRICT.
 *   2. stock_journal_line  — the OUT/IN sides; side app-checked varchar; numeric(18,4) qty/rate/value;
 *                            the four dimension FKs ON DELETE RESTRICT.
 * All FKs ON DELETE RESTRICT (a referenced master/entry can never be hard-deleted out from under a
 * Stock Journal — MAS deactivate-not-delete, design §7 item 4).
 */
export class CreateStockJournal1700001500000 implements MigrationInterface {
  name = 'CreateStockJournal1700001500000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- stock_journal (header) -----------------------------------------------------------------
    await q.query(`
      CREATE TABLE "stock_journal" (
        "id"                              uuid PRIMARY KEY,
        "company_id"                      uuid NOT NULL,
        "financial_year_id"               uuid NOT NULL,
        "entry_no"                        varchar,
        "voucher_date"                    date NOT NULL,
        "mode"                            varchar NOT NULL,
        "status"                          varchar NOT NULL DEFAULT 'DRAFT',
        "from_godown_id"                  uuid,
        "to_godown_id"                    uuid,
        "item_id"                         uuid NOT NULL,
        "quantity"                        numeric(18,4) NOT NULL,
        "rate"                            numeric(18,4),
        "value"                           numeric(18,4),
        "project_id"                      uuid NOT NULL,
        "cost_centre_id"                  uuid NOT NULL,
        "purpose_id"                      uuid NOT NULL,
        "issued_by_id"                    uuid,
        "received_by_id"                  uuid,
        "approved_by_id"                  uuid,
        "approved_at"                     timestamptz,
        "allow_negative_stock"            boolean NOT NULL DEFAULT false,
        "negative_stock_authorised_by_id" uuid,
        "negative_stock_reason"           text,
        "journal_entry_id"                uuid,
        "narration"                       text,
        "posted_at"                       timestamptz,
        "posted_by_id"                    uuid,
        "deleted_at"                      timestamptz,
        "created_at"                      timestamptz NOT NULL DEFAULT now(),
        "updated_at"                      timestamptz NOT NULL DEFAULT now(),
        "created_by"                      uuid,
        "updated_by"                      uuid,
        "version"                         integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_stock_journal_status"
          CHECK ("status" IN ('DRAFT','APPROVED','POSTED','CANCELLED')),
        CONSTRAINT "chk_stock_journal_mode"
          CHECK ("mode" IN ('TRANSFER','ISSUE','ADJUSTMENT')),
        CONSTRAINT "chk_stock_journal_quantity_pos" CHECK ("quantity" > 0),
        CONSTRAINT "fk_stock_journal_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_from_godown"
          FOREIGN KEY ("from_godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_to_godown"
          FOREIGN KEY ("to_godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_item"
          FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_journal_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_stock_journal_company_status_date" ON "stock_journal" ("company_id", "status", "voucher_date")`,
    );
    await q.query(
      `CREATE INDEX "idx_stock_journal_company_from_godown" ON "stock_journal" ("company_id", "from_godown_id")`,
    );
    await q.query(
      `CREATE INDEX "idx_stock_journal_company_to_godown" ON "stock_journal" ("company_id", "to_godown_id")`,
    );
    await q.query(`CREATE INDEX "idx_stock_journal_item" ON "stock_journal" ("item_id")`);

    // ---- stock_journal_line (OUT/IN sides) ---------------------------------------------------------
    await q.query(`
      CREATE TABLE "stock_journal_line" (
        "id"               uuid PRIMARY KEY,
        "stock_journal_id" uuid NOT NULL,
        "line_no"          integer NOT NULL,
        "side"             varchar NOT NULL,
        "godown_id"        uuid NOT NULL,
        "item_id"          uuid NOT NULL,
        "quantity"         numeric(18,4) NOT NULL,
        "rate"             numeric(18,4),
        "value"            numeric(18,4),
        "project_id"       uuid NOT NULL,
        "cost_centre_id"   uuid NOT NULL,
        "purpose_id"       uuid NOT NULL,
        CONSTRAINT "chk_stock_journal_line_side" CHECK ("side" IN ('OUT','IN')),
        CONSTRAINT "chk_stock_journal_line_quantity_pos" CHECK ("quantity" > 0),
        CONSTRAINT "fk_stock_journal_line_journal"
          FOREIGN KEY ("stock_journal_id") REFERENCES "stock_journal" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_line_godown"
          FOREIGN KEY ("godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_line_item"
          FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_line_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_line_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_journal_line_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_stock_journal_line_journal" ON "stock_journal_line" ("stock_journal_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "stock_journal_line"`);
    await q.query(`DROP TABLE IF EXISTS "stock_journal"`);
  }
}
