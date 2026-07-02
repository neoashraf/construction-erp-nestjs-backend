import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PAY payment voucher tables (brief #27 payment-voucher-core). Raw SQL, `synchronize:false`. Creates the
 * TWO PAY-owned tables — NO ledger object (the ledger + its balance/append-only triggers are LED's, already
 * shipped; PAY's PAYMENT posting flows through PostingService into the EXISTING journal_entry/journal_line)
 * and NO PUR/HR object (the settled payables are PUR/HR-owned, already shipped). Includes:
 *   - money columns numeric(18,4) (exact — never float);
 *   - status/payment_mode app-checked varchars; NOT Postgres enums (adding a value = code);
 *   - CHECK bank_charges_amount >= 0, payment_amount >= 0;
 *   - the cheque-ref CHECK: payment_mode = 'CASH' OR cheque_txn_ref IS NOT NULL;
 *   - the §7 list/trace indexes;
 *   - journal_entry_id FK -> LED journal_entry (ON DELETE RESTRICT), null while DRAFT, set at post;
 *   - FKs ON DELETE RESTRICT to company/financial_year/party/payment_account(account)/bank_charges dims.
 * payment_allocation (child, ON DELETE CASCADE from the voucher): one row per settled payable; the resolved
 * control account / dims / party / accrued binding; CHECK amount_allocated > 0, payable_type IN (...),
 * accrued_amount only for LABOUR_PAYABLE; NO FK on payable_id (polymorphic across PUR/HR); party/project/
 * cost_centre/purpose FKs ON DELETE RESTRICT (nullable).
 */
export class CreatePayment1700002200000 implements MigrationInterface {
  name = 'CreatePayment1700002200000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "payment_voucher" (
        "id"                          uuid PRIMARY KEY,
        "company_id"                  uuid NOT NULL,
        "financial_year_id"           uuid NOT NULL,
        "party_id"                    uuid,
        "payment_date"                date NOT NULL,
        "payment_mode"                varchar NOT NULL,
        "payment_account_id"          uuid NOT NULL,
        "cheque_txn_ref"              varchar,
        "bank_charges_amount"         numeric(18,4) NOT NULL DEFAULT 0,
        "bank_charges_project_id"     uuid,
        "bank_charges_cost_centre_id" uuid,
        "bank_charges_purpose_id"     uuid,
        "payment_amount"              numeric(18,4) NOT NULL,
        "narration"                   text,
        "status"                      varchar NOT NULL DEFAULT 'DRAFT',
        "entry_no"                    varchar,
        "journal_entry_id"            uuid,
        "posted_at"                   timestamptz,
        "posted_by"                   uuid,
        "deleted_at"                  timestamptz,
        "created_at"                  timestamptz NOT NULL DEFAULT now(),
        "updated_at"                  timestamptz NOT NULL DEFAULT now(),
        "created_by"                  uuid,
        "updated_by"                  uuid,
        "version"                     integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_payment_voucher_status"
          CHECK ("status" IN ('DRAFT','POSTED','CANCELLED')),
        CONSTRAINT "chk_payment_voucher_payment_mode"
          CHECK ("payment_mode" IN ('CASH','MFS','BANK_TRANSFER','CHEQUE','RTGS')),
        CONSTRAINT "chk_payment_voucher_bank_charges_nonneg" CHECK ("bank_charges_amount" >= 0),
        CONSTRAINT "chk_payment_voucher_amount_nonneg"       CHECK ("payment_amount" >= 0),
        CONSTRAINT "chk_payment_voucher_cheque_ref"
          CHECK ("payment_mode" = 'CASH' OR "cheque_txn_ref" IS NOT NULL),
        CONSTRAINT "fk_payment_voucher_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_voucher_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_voucher_party"
          FOREIGN KEY ("party_id") REFERENCES "party" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_voucher_payment_account"
          FOREIGN KEY ("payment_account_id") REFERENCES "account" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_voucher_bank_charges_project"
          FOREIGN KEY ("bank_charges_project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_voucher_bank_charges_cost_centre"
          FOREIGN KEY ("bank_charges_cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_voucher_bank_charges_purpose"
          FOREIGN KEY ("bank_charges_purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_voucher_journal_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);

    await q.query(`CREATE INDEX "idx_payment_voucher_company_fy" ON "payment_voucher" ("company_id", "financial_year_id")`);
    await q.query(
      `CREATE INDEX "idx_payment_voucher_company_fy_date" ON "payment_voucher" ("company_id", "financial_year_id", "payment_date")`,
    );
    await q.query(`CREATE INDEX "idx_payment_voucher_party" ON "payment_voucher" ("party_id")`);
    await q.query(`CREATE INDEX "idx_payment_voucher_payment_account" ON "payment_voucher" ("payment_account_id")`);
    await q.query(`CREATE INDEX "idx_payment_voucher_company_status" ON "payment_voucher" ("company_id", "status")`);
    await q.query(`CREATE INDEX "idx_payment_voucher_journal_entry" ON "payment_voucher" ("journal_entry_id")`);
    await q.query(`CREATE INDEX "idx_payment_voucher_entry_no" ON "payment_voucher" ("entry_no")`);

    await q.query(`
      CREATE TABLE "payment_allocation" (
        "id"                    uuid PRIMARY KEY,
        "payment_voucher_id"    uuid NOT NULL,
        "line_no"               integer NOT NULL,
        "payable_type"          varchar NOT NULL,
        "payable_id"            uuid NOT NULL,
        "amount_allocated"      numeric(18,4) NOT NULL,
        "accrued_amount"        numeric(18,4),
        "party_id"              uuid,
        "project_id"            uuid,
        "cost_centre_id"        uuid,
        "purpose_id"            uuid,
        "control_account_id"    uuid,
        "control_account_type"  varchar,
        "is_control_account"    boolean,
        CONSTRAINT "chk_payment_allocation_amount_pos" CHECK ("amount_allocated" > 0),
        CONSTRAINT "chk_payment_allocation_payable_type"
          CHECK ("payable_type" IN ('PURCHASE_BILL','LABOUR_PAYABLE','SALARY')),
        CONSTRAINT "chk_payment_allocation_accrued_labour_only"
          CHECK ("payable_type" = 'LABOUR_PAYABLE' OR "accrued_amount" IS NULL),
        CONSTRAINT "fk_payment_allocation_voucher"
          FOREIGN KEY ("payment_voucher_id") REFERENCES "payment_voucher" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_payment_allocation_party"
          FOREIGN KEY ("party_id") REFERENCES "party" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_allocation_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_allocation_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_allocation_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_payment_allocation_voucher" ON "payment_allocation" ("payment_voucher_id")`);
    await q.query(
      `CREATE INDEX "idx_payment_allocation_payable" ON "payment_allocation" ("payable_type", "payable_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "payment_allocation"`);
    await q.query(`DROP TABLE IF EXISTS "payment_voucher"`);
  }
}
