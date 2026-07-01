import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * REQ requisition workflow tables (FR-REQ-001..011/-018/-020..023, brief #18). Raw SQL,
 * `synchronize:false`. Creates the THREE REQ-owned workflow tables — NO ledger/stock object (the issue's
 * stock_movement + consumption journal_entry are INV/LED, added by the downstream issue brief #23). This
 * brief writes NO ledger entry and moves NO stock. Includes:
 *   1. requisition            — the workflow document header. status/priority/approval_tier app-checked
 *                               varchar (adding a value = code, not ALTER TYPE); estimated_value
 *                               numeric(18,4); requisition_no + requisition_seq (a SIMPLE per-company+FY
 *                               reference, NON-gapless — a requisition is not a legal/VAT document; SRS §16);
 *                               the §7 list indexes; @VersionColumn; dimension FKs ON DELETE RESTRICT.
 *   2. requisition_line       — requested/issued/balance numeric(18,4) with the BALANCE-INVARIANT CHECK
 *                               (issued + balance = requested, requested > 0, issued/balance >= 0 —
 *                               FR-REQ-018); the partial-balance index; item FK ON DELETE RESTRICT.
 *   3. requisition_approval   — an append-style audit row per approve/reject; decision/tier app-checked
 *                               varchar; threshold/estimate numeric(18,4); the requisition_id index.
 * All FKs ON DELETE RESTRICT (a referenced master can never be hard-deleted out from under a requisition —
 * MAS deactivate-not-delete, edge 13). REQ adds NO index/trigger to journal_line/stock_movement.
 */
export class CreateRequisition1700001400000 implements MigrationInterface {
  name = 'CreateRequisition1700001400000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- requisition (header) -------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "requisition" (
        "id"                 uuid PRIMARY KEY,
        "company_id"         uuid NOT NULL,
        "financial_year_id"  uuid NOT NULL,
        "requisition_no"     varchar,
        "requisition_seq"    integer,
        "project_id"         uuid NOT NULL,
        "cost_centre_id"     uuid NOT NULL,
        "purpose_id"         uuid NOT NULL,
        "from_godown_id"     uuid,
        "required_date"      date NOT NULL,
        "priority"           varchar NOT NULL DEFAULT 'NORMAL',
        "status"             varchar NOT NULL DEFAULT 'DRAFT',
        "estimated_value"    numeric(18,4) NOT NULL DEFAULT 0,
        "approval_tier"      varchar,
        "submitted_at"       timestamptz,
        "submitted_by_id"    uuid,
        "closed_at"          timestamptz,
        "closed_reason"      text,
        "narration"          text,
        "deleted_at"         timestamptz,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now(),
        "created_by"         uuid,
        "updated_by"         uuid,
        "version"            integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_requisition_status"
          CHECK ("status" IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','PARTIALLY_ISSUED','ISSUED','CLOSED')),
        CONSTRAINT "chk_requisition_priority"
          CHECK ("priority" IN ('LOW','NORMAL','HIGH','URGENT')),
        CONSTRAINT "chk_requisition_tier"
          CHECK ("approval_tier" IS NULL OR "approval_tier" IN ('PM','ACCOUNTS')),
        CONSTRAINT "chk_requisition_estimate_nonneg" CHECK ("estimated_value" >= 0),
        CONSTRAINT "fk_requisition_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_godown"
          FOREIGN KEY ("from_godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_requisition_company_status_reqdate" ON "requisition" ("company_id", "status", "required_date")`,
    );
    await q.query(
      `CREATE INDEX "idx_requisition_company_project" ON "requisition" ("company_id", "project_id")`,
    );
    await q.query(
      `CREATE INDEX "idx_requisition_company_submitted_by" ON "requisition" ("company_id", "submitted_by_id")`,
    );

    // ---- requisition_line -----------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "requisition_line" (
        "id"                 uuid PRIMARY KEY,
        "requisition_id"     uuid NOT NULL,
        "line_no"            integer NOT NULL,
        "item_id"            uuid NOT NULL,
        "requested_quantity" numeric(18,4) NOT NULL,
        "issued_quantity"    numeric(18,4) NOT NULL DEFAULT 0,
        "balance_quantity"   numeric(18,4) NOT NULL,
        "indicative_rate"    numeric(18,4),
        "uom"                varchar NOT NULL,
        CONSTRAINT "chk_requisition_line_requested_pos" CHECK ("requested_quantity" > 0),
        CONSTRAINT "chk_requisition_line_issued_nonneg"  CHECK ("issued_quantity" >= 0),
        CONSTRAINT "chk_requisition_line_balance_nonneg" CHECK ("balance_quantity" >= 0),
        CONSTRAINT "chk_requisition_line_balance_invariant"
          CHECK ("issued_quantity" + "balance_quantity" = "requested_quantity"),
        CONSTRAINT "fk_requisition_line_requisition"
          FOREIGN KEY ("requisition_id") REFERENCES "requisition" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_line_item"
          FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_requisition_line_requisition" ON "requisition_line" ("requisition_id")`,
    );
    // The outstanding-balance read (FR-REQ-021) — only lines with a remainder.
    await q.query(`
      CREATE INDEX "idx_requisition_line_outstanding"
        ON "requisition_line" ("requisition_id", "balance_quantity")
        WHERE "balance_quantity" > 0
    `);

    // ---- requisition_approval (append-style) ----------------------------------------------------
    await q.query(`
      CREATE TABLE "requisition_approval" (
        "id"                        uuid PRIMARY KEY,
        "requisition_id"            uuid NOT NULL,
        "decision"                  varchar NOT NULL,
        "tier"                      varchar NOT NULL,
        "threshold_evaluated"       numeric(18,4) NOT NULL DEFAULT 0,
        "estimated_value_at_review" numeric(18,4) NOT NULL DEFAULT 0,
        "reason"                    text,
        "decided_by"                uuid NOT NULL,
        "decided_at"                timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_requisition_approval_decision" CHECK ("decision" IN ('APPROVED','REJECTED')),
        CONSTRAINT "chk_requisition_approval_tier"     CHECK ("tier" IN ('PM','ACCOUNTS')),
        CONSTRAINT "fk_requisition_approval_requisition"
          FOREIGN KEY ("requisition_id") REFERENCES "requisition" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_requisition_approval_requisition" ON "requisition_approval" ("requisition_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "requisition_approval"`);
    await q.query(`DROP TABLE IF EXISTS "requisition_line"`);
    await q.query(`DROP TABLE IF EXISTS "requisition"`);
  }
}
