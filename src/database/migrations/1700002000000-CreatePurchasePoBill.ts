import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PUR purchase-order + purchase-bill tables (FR-PUR-001..024, purchase-po-bill-posting brief 1 of 2). Raw
 * SQL, `synchronize:false`. Creates FOUR PUR-owned tables — NO ledger object (LED owns journal_entry +
 * its triggers, already shipped) and NO stock object (INV owns stock_movement, already shipped); PUR's
 * bill post flows through PostingService into the EXISTING journal_entry/journal_line and through
 * InventoryService into the EXISTING stock_movement.
 *
 *   1. purchase_order       — a NON-POSTING commitment header; no journal_entry_id, no entry_no
 *                             (FR-PUR-001); status checked varchar (DRAFT|APPROVED|PARTIALLY_BILLED|
 *                             PARTIALLY_RECEIVED|CLOSED|CANCELLED).
 *   2. purchase_order_line  — one row per ordered item; the four dimensions ALL required (project +
 *                             cost_centre + purpose + godown — the Purchase per-line matrix row); derived
 *                             billed_qty/received_qty roll-ups for the PO->Bill->GRN match.
 *   3. purchase_bill        — the posting voucher header; status checked varchar (DRAFT|POSTED|CANCELLED);
 *                             journal_entry_id FK -> journal_entry (LED, nullable while DRAFT);
 *                             purchase_order_id FK -> purchase_order (nullable — direct purchase,
 *                             FR-PUR-003); the net_payable_amount>=0 / gross_amount>=0 CHECKs (FR-PUR-007).
 *   4. purchase_bill_line   — one row per billed item OR non-stock expense line; the stock-XOR-expense
 *                             CHECK (item_id XOR expense_account_id) + godown-on-stock-line CHECK
 *                             (FR-PUR-005, §11); the four dimensions (godown only required when
 *                             is_stock_line); derived received_qty for the GRN match.
 *
 * All FKs ON DELETE RESTRICT (a referenced master/entry can never be hard-deleted out from under a
 * voucher — MAS deactivate-not-delete, design §7 item 5). No append-only trigger on these PUR tables
 * themselves — immutability lives on the REFERENCED journal_entry (LED trigger) and stock_movement (INV
 * trigger); a PUR bill's own POSTED/CANCELLED status transition is app-enforced via
 * assertPostable()/assertPosted() (design §7 item 1/2/7).
 */
export class CreatePurchasePoBill1700002000000 implements MigrationInterface {
  name = 'CreatePurchasePoBill1700002000000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- purchase_order (header) -------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "purchase_order" (
        "id"                      uuid PRIMARY KEY,
        "company_id"              uuid NOT NULL,
        "financial_year_id"       uuid NOT NULL,
        "project_id"              uuid NOT NULL,
        "supplier_id"             uuid NOT NULL,
        "po_ref_no"               varchar,
        "po_date"                 date NOT NULL,
        "expected_delivery_date"  date,
        "status"                  varchar NOT NULL DEFAULT 'DRAFT',
        "narration"               text,
        "approved_by"             uuid,
        "approved_at"             timestamptz,
        "created_at"              timestamptz NOT NULL DEFAULT now(),
        "updated_at"              timestamptz NOT NULL DEFAULT now(),
        "created_by"              uuid,
        "updated_by"              uuid,
        "version"                 integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_purchase_order_status"
          CHECK ("status" IN ('DRAFT','APPROVED','PARTIALLY_BILLED','PARTIALLY_RECEIVED','CLOSED','CANCELLED')),
        CONSTRAINT "fk_purchase_order_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_order_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_order_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_order_supplier"
          FOREIGN KEY ("supplier_id") REFERENCES "party" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_purchase_order_company_status" ON "purchase_order" ("company_id", "status")`);
    await q.query(`CREATE INDEX "idx_purchase_order_supplier" ON "purchase_order" ("supplier_id")`);
    await q.query(`CREATE INDEX "idx_purchase_order_project" ON "purchase_order" ("project_id")`);

    // ---- purchase_order_line -------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "purchase_order_line" (
        "id"                uuid PRIMARY KEY,
        "purchase_order_id" uuid NOT NULL,
        "line_no"           integer NOT NULL,
        "item_id"           uuid NOT NULL,
        "ordered_qty"       numeric(18,4) NOT NULL,
        "rate"              numeric(18,4) NOT NULL,
        "line_amount"       numeric(18,4) NOT NULL,
        "godown_id"         uuid NOT NULL,
        "project_id"        uuid NOT NULL,
        "cost_centre_id"    uuid NOT NULL,
        "purpose_id"        uuid NOT NULL,
        "billed_qty"        numeric(18,4) NOT NULL DEFAULT 0,
        "received_qty"      numeric(18,4) NOT NULL DEFAULT 0,
        CONSTRAINT "chk_purchase_order_line_ordered_qty_pos" CHECK ("ordered_qty" > 0),
        CONSTRAINT "chk_purchase_order_line_rate_nonneg" CHECK ("rate" >= 0),
        CONSTRAINT "chk_purchase_order_line_amount_nonneg" CHECK ("line_amount" >= 0),
        CONSTRAINT "chk_purchase_order_line_billed_nonneg" CHECK ("billed_qty" >= 0),
        CONSTRAINT "chk_purchase_order_line_received_nonneg" CHECK ("received_qty" >= 0),
        CONSTRAINT "fk_purchase_order_line_po"
          FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_order_line_item"
          FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_order_line_godown"
          FOREIGN KEY ("godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_order_line_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_order_line_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_order_line_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_purchase_order_line_po" ON "purchase_order_line" ("purchase_order_id")`);

    // ---- purchase_bill (header) --------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "purchase_bill" (
        "id"                    uuid PRIMARY KEY,
        "company_id"            uuid NOT NULL,
        "financial_year_id"     uuid NOT NULL,
        "project_id"            uuid NOT NULL,
        "supplier_id"           uuid NOT NULL,
        "purchase_order_id"     uuid,
        "supplier_invoice_ref"  varchar,
        "bill_date"             date NOT NULL,
        "due_date"              date NOT NULL,
        "gross_amount"          numeric(18,4) NOT NULL,
        "vat_input_amount"      numeric(18,4) NOT NULL DEFAULT 0,
        "tds_amount"            numeric(18,4) NOT NULL DEFAULT 0,
        "ait_amount"            numeric(18,4) NOT NULL DEFAULT 0,
        "net_payable_amount"    numeric(18,4) NOT NULL,
        "narration"             text,
        "status"                varchar NOT NULL DEFAULT 'DRAFT',
        "entry_no"              varchar,
        "journal_entry_id"      uuid,
        "posted_at"             timestamptz,
        "posted_by"             uuid,
        "deleted_at"            timestamptz,
        "created_at"            timestamptz NOT NULL DEFAULT now(),
        "updated_at"            timestamptz NOT NULL DEFAULT now(),
        "created_by"            uuid,
        "updated_by"            uuid,
        "version"               integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_purchase_bill_status"
          CHECK ("status" IN ('DRAFT','POSTED','CANCELLED')),
        CONSTRAINT "chk_purchase_bill_due_after_bill" CHECK ("due_date" >= "bill_date"),
        CONSTRAINT "chk_purchase_bill_gross_nonneg" CHECK ("gross_amount" >= 0),
        CONSTRAINT "chk_purchase_bill_vat_input_nonneg" CHECK ("vat_input_amount" >= 0),
        CONSTRAINT "chk_purchase_bill_tds_nonneg" CHECK ("tds_amount" >= 0),
        CONSTRAINT "chk_purchase_bill_ait_nonneg" CHECK ("ait_amount" >= 0),
        CONSTRAINT "chk_purchase_bill_net_payable_nonneg" CHECK ("net_payable_amount" >= 0),
        CONSTRAINT "fk_purchase_bill_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_supplier"
          FOREIGN KEY ("supplier_id") REFERENCES "party" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_purchase_order"
          FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_journal_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_purchase_bill_company_status_date" ON "purchase_bill" ("company_id", "status", "bill_date")`,
    );
    await q.query(`CREATE INDEX "idx_purchase_bill_company_fy" ON "purchase_bill" ("company_id", "financial_year_id")`);
    await q.query(`CREATE INDEX "idx_purchase_bill_supplier" ON "purchase_bill" ("company_id", "supplier_id")`);
    await q.query(`CREATE INDEX "idx_purchase_bill_project" ON "purchase_bill" ("company_id", "project_id")`);
    await q.query(`CREATE INDEX "idx_purchase_bill_purchase_order" ON "purchase_bill" ("purchase_order_id")`);
    await q.query(`CREATE INDEX "idx_purchase_bill_journal_entry" ON "purchase_bill" ("journal_entry_id")`);
    await q.query(`CREATE INDEX "idx_purchase_bill_entry_no" ON "purchase_bill" ("entry_no")`);

    // ---- purchase_bill_line ------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "purchase_bill_line" (
        "id"                  uuid PRIMARY KEY,
        "purchase_bill_id"    uuid NOT NULL,
        "line_no"             integer NOT NULL,
        "item_id"             uuid,
        "expense_account_id"  uuid,
        "is_stock_line"       boolean NOT NULL,
        "billed_qty"          numeric(18,4) NOT NULL,
        "rate"                numeric(18,4) NOT NULL,
        "line_amount"         numeric(18,4) NOT NULL,
        "vat_input_amount"    numeric(18,4) NOT NULL DEFAULT 0,
        "tds_amount"          numeric(18,4) NOT NULL DEFAULT 0,
        "ait_amount"          numeric(18,4) NOT NULL DEFAULT 0,
        "godown_id"           uuid,
        "project_id"          uuid NOT NULL,
        "cost_centre_id"      uuid NOT NULL,
        "purpose_id"          uuid NOT NULL,
        "received_qty"        numeric(18,4) NOT NULL DEFAULT 0,
        CONSTRAINT "chk_purchase_bill_line_type_xor"
          CHECK ((("item_id" IS NOT NULL)::int + ("expense_account_id" IS NOT NULL)::int) = 1),
        CONSTRAINT "chk_purchase_bill_line_stock_flag_matches_item"
          CHECK ("is_stock_line" = ("item_id" IS NOT NULL)),
        CONSTRAINT "chk_purchase_bill_line_godown_on_stock"
          CHECK (NOT "is_stock_line" OR "godown_id" IS NOT NULL),
        CONSTRAINT "chk_purchase_bill_line_billed_qty_pos" CHECK ("billed_qty" > 0),
        CONSTRAINT "chk_purchase_bill_line_rate_nonneg" CHECK ("rate" >= 0),
        CONSTRAINT "chk_purchase_bill_line_amount_nonneg" CHECK ("line_amount" >= 0),
        CONSTRAINT "chk_purchase_bill_line_vat_input_nonneg" CHECK ("vat_input_amount" >= 0),
        CONSTRAINT "chk_purchase_bill_line_tds_nonneg" CHECK ("tds_amount" >= 0),
        CONSTRAINT "chk_purchase_bill_line_ait_nonneg" CHECK ("ait_amount" >= 0),
        CONSTRAINT "chk_purchase_bill_line_received_nonneg" CHECK ("received_qty" >= 0),
        CONSTRAINT "fk_purchase_bill_line_bill"
          FOREIGN KEY ("purchase_bill_id") REFERENCES "purchase_bill" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_line_item"
          FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_line_expense_account"
          FOREIGN KEY ("expense_account_id") REFERENCES "account" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_line_godown"
          FOREIGN KEY ("godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_line_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_line_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purchase_bill_line_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_purchase_bill_line_bill" ON "purchase_bill_line" ("purchase_bill_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "purchase_bill_line"`);
    await q.query(`DROP TABLE IF EXISTS "purchase_bill"`);
    await q.query(`DROP TABLE IF EXISTS "purchase_order_line"`);
    await q.query(`DROP TABLE IF EXISTS "purchase_order"`);
  }
}
