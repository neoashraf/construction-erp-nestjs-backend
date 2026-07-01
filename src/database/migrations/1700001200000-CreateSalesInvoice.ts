import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SAL sales-invoice (IPC) voucher table (FR-SAL-001..014/-021..023, brief #16). Raw SQL,
 * `synchronize:false`. Creates the ONE SAL-owned voucher table `sales_invoice` — NO ledger object (the
 * ledger + its balance/append-only triggers are LED's, already shipped). Includes:
 *   - money/rate columns numeric(18,4) (exact — never float);
 *   - status app-checked varchar (DRAFT|POSTED|CANCELLED); NOT a Postgres enum (adding a state = code);
 *   - CHECK certified_amount > 0 and currently_due_amount >= 0 (FR-SAL-004, edge case 14);
 *   - the (company_id, project_id, ipc_seq_no) UNIQUE index — one IPC per sequence per project
 *     (FR-SAL-014), enforced only over non-deleted drafts so a hard-deleted draft's number can be reused;
 *   - the §7 list/trace indexes;
 *   - journal_entry_id FK → LED `journal_entry` (ON DELETE RESTRICT), null while DRAFT, set at post;
 *   - FKs ON DELETE RESTRICT to company/financial_year/project/customer/cost_centre/purpose (a referenced
 *     master or ledger entry can never be hard-deleted out from under an IPC).
 * SAL adds NO index/trigger to `journal_line` — the posted ledger is LED's.
 */
export class CreateSalesInvoice1700001200000 implements MigrationInterface {
  name = 'CreateSalesInvoice1700001200000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "sales_invoice" (
        "id"                       uuid PRIMARY KEY,
        "company_id"               uuid NOT NULL,
        "financial_year_id"        uuid NOT NULL,
        "project_id"               uuid NOT NULL,
        "customer_id"              uuid NOT NULL,
        "ipc_seq_no"               integer NOT NULL,
        "ipc_date"                 date NOT NULL,
        "bill_date"                date NOT NULL,
        "due_date"                 date NOT NULL,
        "work_completed_pct"       numeric(18,4) NOT NULL DEFAULT 0,
        "certified_amount"         numeric(18,4) NOT NULL,
        "cost_centre_id"           uuid NOT NULL,
        "purpose_id"               uuid NOT NULL,
        "output_vat_amount"        numeric(18,4) NOT NULL DEFAULT 0,
        "ait_tds_amount"           numeric(18,4) NOT NULL DEFAULT 0,
        "retention_amount"         numeric(18,4) NOT NULL DEFAULT 0,
        "advance_recovered_amount" numeric(18,4) NOT NULL DEFAULT 0,
        "currently_due_amount"     numeric(18,4) NOT NULL DEFAULT 0,
        "retention_rate_pct"       numeric(18,4) NOT NULL DEFAULT 0,
        "advance_rate_pct"         numeric(18,4) NOT NULL DEFAULT 0,
        "narration"                text,
        "status"                   varchar NOT NULL DEFAULT 'DRAFT',
        "entry_no"                 varchar,
        "journal_entry_id"         uuid,
        "posted_at"                timestamptz,
        "posted_by"                uuid,
        "deleted_at"               timestamptz,
        "created_at"               timestamptz NOT NULL DEFAULT now(),
        "updated_at"               timestamptz NOT NULL DEFAULT now(),
        "created_by"               uuid,
        "updated_by"               uuid,
        "version"                  integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_sales_invoice_status"          CHECK ("status" IN ('DRAFT','POSTED','CANCELLED')),
        CONSTRAINT "chk_sales_invoice_certified_pos"   CHECK ("certified_amount" > 0),
        CONSTRAINT "chk_sales_invoice_due_nonneg"      CHECK ("currently_due_amount" >= 0),
        CONSTRAINT "chk_sales_invoice_seq_pos"         CHECK ("ipc_seq_no" > 0),
        CONSTRAINT "fk_sales_invoice_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_sales_invoice_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_sales_invoice_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_sales_invoice_customer"
          FOREIGN KEY ("customer_id") REFERENCES "party" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_sales_invoice_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_sales_invoice_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_sales_invoice_journal_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);

    // One IPC per sequence per project (FR-SAL-014); the register order rides this index. Scoped to
    // non-deleted rows so a hard-deleted draft frees its sequence number.
    await q.query(`
      CREATE UNIQUE INDEX "uq_sales_invoice_project_seq"
        ON "sales_invoice" ("company_id", "project_id", "ipc_seq_no")
        WHERE "deleted_at" IS NULL
    `);
    await q.query(`CREATE INDEX "idx_sales_invoice_company_fy" ON "sales_invoice" ("company_id", "financial_year_id")`);
    await q.query(`CREATE INDEX "idx_sales_invoice_company_status" ON "sales_invoice" ("company_id", "status")`);
    await q.query(`CREATE INDEX "idx_sales_invoice_customer" ON "sales_invoice" ("customer_id")`);
    await q.query(`CREATE INDEX "idx_sales_invoice_journal_entry" ON "sales_invoice" ("journal_entry_id")`);
    await q.query(`CREATE INDEX "idx_sales_invoice_entry_no" ON "sales_invoice" ("entry_no")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "sales_invoice"`);
  }
}
