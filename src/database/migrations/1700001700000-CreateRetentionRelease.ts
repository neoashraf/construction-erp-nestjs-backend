import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SAL retention-release voucher table (FR-SAL-018..020, brief #37 sales-ipc-retention-release). Raw SQL,
 * `synchronize:false`. Creates the ONE new SAL-owned table `retention_release` — NO ledger object (the
 * ledger + its balance/append-only triggers are LED's, already shipped) and NO change to `sales_invoice`
 * (already shipped by 1700001200000-CreateSalesInvoice). Includes:
 *   - money column numeric(18,4) (exact — never float);
 *   - `released_amount > 0` CHECK (FR-SAL-019);
 *   - status app-checked varchar (DRAFT|POSTED|CANCELLED); NOT a Postgres enum (adding a state = code);
 *   - the `(company_id, ipc_id)` index — retention held/released per IPC (§7);
 *   - journal_entry_id FK -> LED journal_entry (ON DELETE RESTRICT), null while DRAFT, set at post;
 *   - ipc_id FK -> SAL sales_invoice (ON DELETE RESTRICT);
 *   - FKs ON DELETE RESTRICT to company/financial_year/project/customer(party)/cost_centre/purpose (a
 *     referenced master or ledger entry can never be hard-deleted out from under a release).
 */
export class CreateRetentionRelease1700001700000 implements MigrationInterface {
  name = 'CreateRetentionRelease1700001700000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "retention_release" (
        "id"                  uuid PRIMARY KEY,
        "company_id"          uuid NOT NULL,
        "financial_year_id"   uuid NOT NULL,
        "ipc_id"              uuid NOT NULL,
        "project_id"          uuid NOT NULL,
        "customer_id"         uuid NOT NULL,
        "cost_centre_id"      uuid NOT NULL,
        "purpose_id"          uuid NOT NULL,
        "release_date"        date NOT NULL,
        "released_amount"     numeric(18,4) NOT NULL,
        "narration"           text,
        "status"              varchar NOT NULL DEFAULT 'DRAFT',
        "entry_no"            varchar,
        "journal_entry_id"    uuid,
        "posted_at"           timestamptz,
        "posted_by"           uuid,
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        "updated_at"          timestamptz NOT NULL DEFAULT now(),
        "created_by"          uuid,
        "updated_by"          uuid,
        "version"             integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_retention_release_status"
          CHECK ("status" IN ('DRAFT','POSTED','CANCELLED')),
        CONSTRAINT "chk_retention_release_amount_pos"
          CHECK ("released_amount" > 0),
        CONSTRAINT "fk_retention_release_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_retention_release_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_retention_release_ipc"
          FOREIGN KEY ("ipc_id") REFERENCES "sales_invoice" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_retention_release_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_retention_release_customer"
          FOREIGN KEY ("customer_id") REFERENCES "party" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_retention_release_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_retention_release_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_retention_release_journal_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);

    await q.query(`CREATE INDEX "idx_retention_release_company_ipc" ON "retention_release" ("company_id", "ipc_id")`);
    await q.query(`CREATE INDEX "idx_retention_release_journal_entry" ON "retention_release" ("journal_entry_id")`);
    await q.query(`CREATE INDEX "idx_retention_release_company_fy" ON "retention_release" ("company_id", "financial_year_id")`);
    await q.query(`CREATE INDEX "idx_retention_release_entry_no" ON "retention_release" ("entry_no")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "retention_release"`);
  }
}
