import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * REC receipt voucher table + the receipt_allocation view (FR-REC-001..025, brief #24). Raw SQL,
 * `synchronize:false`. Creates the ONE REC-owned voucher table `receipt` — NO ledger object (the ledger +
 * its balance/append-only triggers are LED's, already shipped) and NO SAL object (the IPC is SAL's,
 * already shipped by 1700001200000-CreateSalesInvoice). Includes:
 *   - money columns numeric(18,4) (exact — never float);
 *   - status/payment_mode/receipt_type app-checked varchars; NOT Postgres enums (adding a value = code);
 *   - CHECK amount_settled = cash_received + tax_deducted_at_source, amount_settled > 0, cash_received >= 0,
 *     tax_deducted_at_source >= 0 (FR-REC-019/-020);
 *   - the reference-XOR CHECK: exactly one of ipc_id / general_target_account_id, matching receipt_type
 *     (FR-REC-001);
 *   - the cheque-ref CHECK: payment_mode IN ('MFS','BANK_TRANSFER','CHEQUE') => cheque_txn_ref IS NOT NULL
 *     (FR-REC-004);
 *   - the §7 list/trace indexes;
 *   - journal_entry_id FK -> LED journal_entry (ON DELETE RESTRICT), null while DRAFT, set at post;
 *   - ipc_id FK -> SAL sales_invoice (ON DELETE RESTRICT), null unless receipt_type = IPC_LINKED;
 *   - FKs ON DELETE RESTRICT to company/financial_year/party/project/cost_centre/purpose/deposit account/
 *     general_target_account (a referenced master/ledger entry/IPC can never be hard-deleted out from
 *     under a receipt).
 * The `receipt_allocation` VIEW (design §2.5/§5.3) selects posted, non-reversed IPC-linked receipts as
 * (ipc_id, receipt_id, amount_applied) for SAL's ReceiptAllocationPort (brief #21) to read in-process.
 */
export class CreateReceipt1700001600000 implements MigrationInterface {
  name = 'CreateReceipt1700001600000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "receipt" (
        "id"                         uuid PRIMARY KEY,
        "company_id"                 uuid NOT NULL,
        "financial_year_id"          uuid NOT NULL,
        "receipt_type"               varchar NOT NULL,
        "receipt_date"               date NOT NULL,
        "payment_mode"               varchar NOT NULL,
        "deposit_account_id"         uuid NOT NULL,
        "party_id"                   uuid NOT NULL,
        "project_id"                 uuid,
        "cost_centre_id"             uuid NOT NULL,
        "purpose_id"                 uuid,
        "ipc_id"                     uuid,
        "general_target_account_id"  uuid,
        "amount_settled"             numeric(18,4) NOT NULL,
        "cash_received"              numeric(18,4) NOT NULL,
        "tax_deducted_at_source"     numeric(18,4) NOT NULL DEFAULT 0,
        "cheque_txn_ref"             varchar,
        "narration"                  text,
        "status"                     varchar NOT NULL DEFAULT 'DRAFT',
        "entry_no"                   varchar,
        "journal_entry_id"           uuid,
        "posted_at"                  timestamptz,
        "posted_by"                  uuid,
        "deleted_at"                 timestamptz,
        "created_at"                 timestamptz NOT NULL DEFAULT now(),
        "updated_at"                 timestamptz NOT NULL DEFAULT now(),
        "created_by"                 uuid,
        "updated_by"                 uuid,
        "version"                    integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_receipt_status"
          CHECK ("status" IN ('DRAFT','POSTED','CANCELLED')),
        CONSTRAINT "chk_receipt_payment_mode"
          CHECK ("payment_mode" IN ('CASH','MFS','BANK_TRANSFER','CHEQUE')),
        CONSTRAINT "chk_receipt_type"
          CHECK ("receipt_type" IN ('IPC_LINKED','GENERAL')),
        CONSTRAINT "chk_receipt_composition"
          CHECK ("amount_settled" = "cash_received" + "tax_deducted_at_source"),
        CONSTRAINT "chk_receipt_settled_pos"      CHECK ("amount_settled" > 0),
        CONSTRAINT "chk_receipt_cash_nonneg"      CHECK ("cash_received" >= 0),
        CONSTRAINT "chk_receipt_tax_nonneg"       CHECK ("tax_deducted_at_source" >= 0),
        CONSTRAINT "chk_receipt_reference_xor"
          CHECK (
            ("ipc_id" IS NOT NULL AND "general_target_account_id" IS NULL AND "receipt_type" = 'IPC_LINKED')
            OR
            ("ipc_id" IS NULL AND "general_target_account_id" IS NOT NULL AND "receipt_type" = 'GENERAL')
          ),
        CONSTRAINT "chk_receipt_cheque_ref"
          CHECK (
            "payment_mode" NOT IN ('MFS','BANK_TRANSFER','CHEQUE') OR "cheque_txn_ref" IS NOT NULL
          ),
        CONSTRAINT "fk_receipt_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_receipt_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_receipt_deposit_account"
          FOREIGN KEY ("deposit_account_id") REFERENCES "account" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_receipt_party"
          FOREIGN KEY ("party_id") REFERENCES "party" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_receipt_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_receipt_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_receipt_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_receipt_ipc"
          FOREIGN KEY ("ipc_id") REFERENCES "sales_invoice" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_receipt_general_target_account"
          FOREIGN KEY ("general_target_account_id") REFERENCES "account" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_receipt_journal_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);

    await q.query(`CREATE INDEX "idx_receipt_company_fy" ON "receipt" ("company_id", "financial_year_id")`);
    await q.query(`CREATE INDEX "idx_receipt_company_status" ON "receipt" ("company_id", "status")`);
    await q.query(`CREATE INDEX "idx_receipt_company_ipc" ON "receipt" ("company_id", "ipc_id")`);
    await q.query(`CREATE INDEX "idx_receipt_party" ON "receipt" ("party_id")`);
    await q.query(`CREATE INDEX "idx_receipt_company_project" ON "receipt" ("company_id", "project_id")`);
    await q.query(`CREATE INDEX "idx_receipt_journal_entry" ON "receipt" ("journal_entry_id")`);
    await q.query(`CREATE INDEX "idx_receipt_entry_no" ON "receipt" ("entry_no")`);

    // receipt_allocation — the seam SAL's ReceiptAllocationPort reads (design §2.5/§5.3). Posted,
    // non-reversed IPC-linked receipts only; a cancelled receipt drops out automatically.
    await q.query(`
      CREATE VIEW "receipt_allocation" AS
      SELECT r.ipc_id AS ipc_id, r.id AS receipt_id, r.amount_settled AS amount_applied
      FROM   "receipt" r
      JOIN   "journal_entry" je ON je.id = r.journal_entry_id
      WHERE  r.receipt_type = 'IPC_LINKED'
        AND  r.status = 'POSTED'
        AND  NOT EXISTS (SELECT 1 FROM "journal_entry" rev WHERE rev.reversal_of = je.id)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP VIEW IF EXISTS "receipt_allocation"`);
    await q.query(`DROP TABLE IF EXISTS "receipt"`);
  }
}
