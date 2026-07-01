import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * REQ requisition-issue tables (FR-REQ-012..019, brief #23 — requisition-issue-posting, REQ brief 2 of 2).
 * Raw SQL, `synchronize:false`. Adds the two tables the issue half of REQ needs, referenced by brief #18's
 * `requisition`/`requisition_line` (unchanged here) and by INV's `stock_movement` + LED's `journal_entry`:
 *   1. requisition_issue      — one row per issue event; journal_entry_id FK -> LED (the ONE consumption
 *                               entry covering every line of this issue); issued_value numeric(18,4);
 *                               negative_stock_authorised_by_id nullable; reversed_at/reversed_by_id
 *                               nullable (append-only — SET once by a reversal, never cleared); the
 *                               journal_entry_id index (trace an issue to its entry and back).
 *   2. requisition_issue_line — one row per item issued within an issue; requisition_line_id (the line
 *                               fulfilled) + stock_movement_id FK -> INV `stock_movement` (the movement
 *                               INV wrote for this line); numeric(18,4) qty/rate/value with the
 *                               `value = qty * rate` CHECK (mirrors `stock_journal_line`'s style exactly);
 *                               the stock_movement_id index.
 * All FKs ON DELETE RESTRICT (a referenced master/entry/movement/requisition/line can never be
 * hard-deleted out from under an issue — MAS deactivate-not-delete, design §7 item 4). No append-only
 * trigger on these REQ tables themselves (design §7 item 6) — immutability lives on the REFERENCED
 * `stock_movement` (INV trigger) and `journal_entry` (LED trigger); a REQ issue row's `reversed_at`/
 * `reversed_by_id` are the ONLY columns a reversal ever sets, app-enforced via `assertNotReversed()`.
 */
export class CreateRequisitionIssue1700001900000 implements MigrationInterface {
  name = 'CreateRequisitionIssue1700001900000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- requisition_issue (header) ---------------------------------------------------------------
    await q.query(`
      CREATE TABLE "requisition_issue" (
        "id"                              uuid PRIMARY KEY,
        "requisition_id"                  uuid NOT NULL,
        "issue_no"                        integer NOT NULL,
        "from_godown_id"                  uuid NOT NULL,
        "journal_entry_id"                uuid NOT NULL,
        "entry_no"                        varchar,
        "issued_value"                    numeric(18,4) NOT NULL,
        "issued_by_id"                    uuid NOT NULL,
        "issued_at"                       timestamptz NOT NULL DEFAULT now(),
        "negative_stock_authorised_by_id" uuid,
        "reversed_at"                     timestamptz,
        "reversed_by_id"                  uuid,
        CONSTRAINT "chk_requisition_issue_no_pos" CHECK ("issue_no" > 0),
        CONSTRAINT "chk_requisition_issue_value_nonneg" CHECK ("issued_value" >= 0),
        CONSTRAINT "chk_requisition_issue_reversal_pair"
          CHECK (("reversed_at" IS NULL) = ("reversed_by_id" IS NULL)),
        CONSTRAINT "uq_requisition_issue_no" UNIQUE ("requisition_id", "issue_no"),
        CONSTRAINT "fk_requisition_issue_requisition"
          FOREIGN KEY ("requisition_id") REFERENCES "requisition" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_issue_from_godown"
          FOREIGN KEY ("from_godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_issue_journal_entry"
          FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_requisition_issue_requisition" ON "requisition_issue" ("requisition_id")`,
    );
    await q.query(
      `CREATE INDEX "idx_requisition_issue_journal_entry" ON "requisition_issue" ("journal_entry_id")`,
    );

    // ---- requisition_issue_line --------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "requisition_issue_line" (
        "id"                  uuid PRIMARY KEY,
        "requisition_issue_id" uuid NOT NULL,
        "requisition_line_id" uuid NOT NULL,
        "item_id"             uuid NOT NULL,
        "godown_id"           uuid NOT NULL,
        "stock_movement_id"   uuid NOT NULL,
        "issued_quantity"     numeric(18,4) NOT NULL,
        "rate"                numeric(18,4) NOT NULL,
        "value"               numeric(18,4) NOT NULL,
        CONSTRAINT "chk_requisition_issue_line_qty_pos" CHECK ("issued_quantity" > 0),
        CONSTRAINT "chk_requisition_issue_line_rate_nonneg" CHECK ("rate" >= 0),
        CONSTRAINT "chk_requisition_issue_line_value_nonneg" CHECK ("value" >= 0),
        CONSTRAINT "chk_requisition_issue_line_value_eq_qty_rate"
          CHECK ("value" = "issued_quantity" * "rate"),
        CONSTRAINT "fk_requisition_issue_line_issue"
          FOREIGN KEY ("requisition_issue_id") REFERENCES "requisition_issue" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_issue_line_requisition_line"
          FOREIGN KEY ("requisition_line_id") REFERENCES "requisition_line" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_issue_line_item"
          FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_issue_line_godown"
          FOREIGN KEY ("godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_requisition_issue_line_stock_movement"
          FOREIGN KEY ("stock_movement_id") REFERENCES "stock_movement" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_requisition_issue_line_issue" ON "requisition_issue_line" ("requisition_issue_id")`,
    );
    await q.query(
      `CREATE INDEX "idx_requisition_issue_line_stock_movement" ON "requisition_issue_line" ("stock_movement_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "requisition_issue_line"`);
    await q.query(`DROP TABLE IF EXISTS "requisition_issue"`);
  }
}
