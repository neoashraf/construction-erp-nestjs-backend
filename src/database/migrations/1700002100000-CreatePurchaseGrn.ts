import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PUR GRN tables (FR-PUR-015..018, purchase-grn-matching brief 2 of 2). Raw SQL, `synchronize:false`.
 * Creates TWO PUR-owned tables — `grn` + `grn_line` — and NOTHING else: NO ledger object, NO stock object,
 * NO GRN-clearing account seed.
 *
 * ── §10 Q4 GRN-CLEARING DECISION — RESOLVED to option (a): "received = billed at bill post" ─────────────
 * Per design 08-purchase §10's own recommendation ("ship (a) as the default"), under the platform's
 * assumed-defaults-pending-client convention (CLAUDE.md): the Purchase BILL post carries the receipt
 * (brief #25 already rolls inventory + posts the payable for the billed quantity). The GRN is therefore an
 * INFORMATIONAL physical-receipt record — posting a GRN writes NO stock_movement (a second receiveIn would
 * DOUBLE-COUNT stock), NO journal_entry (no GRN-clearing account exists), and consumes NO voucher number.
 * Hence these tables carry NO journal_entry_id, NO stock-movement reference, and NO entry_no column —
 * `grn_ref_no` is the GRN's own simple reference series (SRS §16, PO/GRN numbering RESOLVED), not a
 * gapless PURCHASE number. If the client later confirms decoupled receipt (goods-in-transit), option (b)
 * adds a MAS GRN-clearing account + posting columns in a NEW migration — this one is never edited.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   1. grn       — physical-receipt header against a PO and/or Bill (both nullable FKs — a GRN may
 *                  reference either or both); status checked varchar (DRAFT|POSTED|CANCELLED); cancel is a
 *                  status flip (nothing to unwind under option (a)).
 *   2. grn_line  — one row per received item; `received_qty > 0` CHECK (FR-PUR-015); rate/received_value
 *                  numeric(18,4); the receiving godown + four dimensions (informational, mirroring the
 *                  referenced bill line); nullable `purchase_bill_line_id` (partial receipt per bill line,
 *                  FR-PUR-018); `match_status` snapshotted at post (FR-PUR-017, advisory — §10 Q2).
 *
 * All FKs ON DELETE RESTRICT (design §7 items 5/6). Indexes serve the match/register reads: per-bill /
 * per-PO receipt lookup, per-bill-line received-so-far (partial receipt), supplier/project register scans.
 */
export class CreatePurchaseGrn1700002100000 implements MigrationInterface {
  name = 'CreatePurchaseGrn1700002100000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- grn (header) --------------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "grn" (
        "id"                 uuid PRIMARY KEY,
        "company_id"         uuid NOT NULL,
        "financial_year_id"  uuid NOT NULL,
        "project_id"         uuid NOT NULL,
        "supplier_id"        uuid NOT NULL,
        "purchase_order_id"  uuid,
        "purchase_bill_id"   uuid,
        "grn_ref_no"         varchar,
        "receipt_date"       date NOT NULL,
        "status"             varchar NOT NULL DEFAULT 'DRAFT',
        "received_by"        uuid,
        "narration"          text,
        "posted_at"          timestamptz,
        "posted_by"          uuid,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now(),
        "created_by"         uuid,
        "updated_by"         uuid,
        "version"            integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_grn_status" CHECK ("status" IN ('DRAFT','POSTED','CANCELLED')),
        CONSTRAINT "fk_grn_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_financial_year"
          FOREIGN KEY ("financial_year_id") REFERENCES "financial_year" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_supplier"
          FOREIGN KEY ("supplier_id") REFERENCES "party" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_purchase_order"
          FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_purchase_bill"
          FOREIGN KEY ("purchase_bill_id") REFERENCES "purchase_bill" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_grn_company_status_date" ON "grn" ("company_id", "status", "receipt_date")`);
    await q.query(`CREATE INDEX "idx_grn_supplier" ON "grn" ("company_id", "supplier_id")`);
    await q.query(`CREATE INDEX "idx_grn_project" ON "grn" ("company_id", "project_id")`);
    await q.query(`CREATE INDEX "idx_grn_purchase_bill" ON "grn" ("purchase_bill_id")`);
    await q.query(`CREATE INDEX "idx_grn_purchase_order" ON "grn" ("purchase_order_id")`);

    // ---- grn_line ------------------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "grn_line" (
        "id"                     uuid PRIMARY KEY,
        "grn_id"                 uuid NOT NULL,
        "line_no"                integer NOT NULL,
        "purchase_bill_line_id"  uuid,
        "item_id"                uuid NOT NULL,
        "received_qty"           numeric(18,4) NOT NULL,
        "rate"                   numeric(18,4) NOT NULL,
        "received_value"         numeric(18,4) NOT NULL,
        "godown_id"              uuid NOT NULL,
        "project_id"             uuid NOT NULL,
        "cost_centre_id"         uuid NOT NULL,
        "purpose_id"             uuid NOT NULL,
        "match_status"           varchar,
        CONSTRAINT "chk_grn_line_received_qty_pos" CHECK ("received_qty" > 0),
        CONSTRAINT "chk_grn_line_rate_nonneg" CHECK ("rate" >= 0),
        CONSTRAINT "chk_grn_line_value_nonneg" CHECK ("received_value" >= 0),
        CONSTRAINT "chk_grn_line_match_status"
          CHECK ("match_status" IS NULL OR "match_status" IN ('MATCHED','OVER_RECEIVED','UNDER_RECEIVED','PENDING_RECEIPT')),
        CONSTRAINT "fk_grn_line_grn"
          FOREIGN KEY ("grn_id") REFERENCES "grn" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_line_bill_line"
          FOREIGN KEY ("purchase_bill_line_id") REFERENCES "purchase_bill_line" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_line_item"
          FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_line_godown"
          FOREIGN KEY ("godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_line_project"
          FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_line_cost_centre"
          FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_grn_line_purpose"
          FOREIGN KEY ("purpose_id") REFERENCES "purpose" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_grn_line_grn" ON "grn_line" ("grn_id")`);
    await q.query(`CREATE INDEX "idx_grn_line_bill_line" ON "grn_line" ("purchase_bill_line_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "grn_line"`);
    await q.query(`DROP TABLE IF EXISTS "grn"`);
  }
}
