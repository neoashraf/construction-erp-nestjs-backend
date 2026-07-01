import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * INV stock-ledger core (FR-INV-001/-004/-005/-010/-020, brief #14). Raw SQL, `synchronize:false`.
 * Creates the append-only `stock_movement` fact table and the `stock_balance` lock + cache row with all
 * DB-level integrity, mirroring the LED ledger triggers:
 *   - BEFORE UPDATE OR DELETE append-only trigger on stock_movement → RAISE (FR-INV-020, CLAUDE.md);
 *   - CHECKs: quantity > 0, value >= 0, rate >= 0, direction IN ('IN','OUT') (design §7);
 *   - stock_balance UNIQUE on (company_id, godown_id, item_id) — the SELECT … FOR UPDATE lock target;
 *   - FKs ON DELETE RESTRICT (company / godown / item / reversal_of self-FK) — a referenced master/entry
 *     can never be hard-deleted out from under a movement (deactivate-not-delete, edge 12);
 *   - the §7 indexes (dimension/latest/source/reversal) — stock_movement is high-volume (NFR-011).
 *
 * The `(company, godown, item)` non-negative guard is CONDITIONAL (relaxed for an authorised negative
 * move, FR-INV-014/-015) so it is enforced in the app (valuation), NOT as a hard DB CHECK.
 */
export class CreateStockMovementAndBalance1700001000000 implements MigrationInterface {
  name = 'CreateStockMovementAndBalance1700001000000';

  public async up(q: QueryRunner): Promise<void> {
    // ---- stock_movement — the append-only projection source ----------------------------------
    await q.query(`
      CREATE TABLE "stock_movement" (
        "id"                  uuid PRIMARY KEY,
        "company_id"          uuid NOT NULL,
        "godown_id"           uuid NOT NULL,
        "item_id"             uuid NOT NULL,
        "source_type"         varchar NOT NULL,
        "source_id"           uuid NOT NULL,
        "direction"           varchar NOT NULL,
        "quantity"            numeric(18,4) NOT NULL,
        "rate"                numeric(18,4) NOT NULL,
        "value"               numeric(18,4) NOT NULL,
        "balance_qty_after"   numeric(18,4) NOT NULL,
        "balance_value_after" numeric(18,4) NOT NULL,
        "avg_rate_after"      numeric(18,4),
        "is_reversal"         boolean NOT NULL DEFAULT false,
        "reversal_of"         uuid,
        "voucher_date"        date NOT NULL,
        "posted_at"           timestamptz NOT NULL,
        "posted_by"           uuid NOT NULL,
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_stock_movement_qty_pos"    CHECK ("quantity" > 0),
        CONSTRAINT "chk_stock_movement_value_nonneg" CHECK ("value" >= 0),
        CONSTRAINT "chk_stock_movement_rate_nonneg"  CHECK ("rate" >= 0),
        CONSTRAINT "chk_stock_movement_direction"  CHECK ("direction" IN ('IN','OUT')),
        CONSTRAINT "fk_stock_movement_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_movement_godown"
          FOREIGN KEY ("godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_movement_item"
          FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_movement_reversal_of"
          FOREIGN KEY ("reversal_of") REFERENCES "stock_movement" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX "idx_stock_movement_dim_date" ON "stock_movement" ("company_id", "godown_id", "item_id", "voucher_date")`);
    await q.query(`CREATE INDEX "idx_stock_movement_latest" ON "stock_movement" ("godown_id", "item_id", "posted_at")`);
    await q.query(`CREATE INDEX "idx_stock_movement_source" ON "stock_movement" ("source_type", "source_id")`);
    await q.query(`CREATE INDEX "idx_stock_movement_reversal_of" ON "stock_movement" ("reversal_of")`);

    // Append-only: posted movements are immutable at the storage layer (FR-INV-020, mirrors LED).
    await q.query(`
      CREATE OR REPLACE FUNCTION ze_stock_movement_append_only() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await q.query(`
      CREATE TRIGGER "trg_stock_movement_append_only"
        BEFORE UPDATE OR DELETE ON "stock_movement"
        FOR EACH ROW EXECUTE FUNCTION ze_stock_movement_append_only();
    `);

    // ---- stock_balance — the per-(company,godown,item) lock + cache row -----------------------
    await q.query(`
      CREATE TABLE "stock_balance" (
        "id"               uuid PRIMARY KEY,
        "company_id"       uuid NOT NULL,
        "godown_id"        uuid NOT NULL,
        "item_id"          uuid NOT NULL,
        "quantity_on_hand" numeric(18,4) NOT NULL DEFAULT 0,
        "total_value"      numeric(18,4) NOT NULL DEFAULT 0,
        "avg_rate"         numeric(18,4),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        "version"          integer NOT NULL DEFAULT 1,
        CONSTRAINT "uq_stock_balance_triple" UNIQUE ("company_id", "godown_id", "item_id"),
        CONSTRAINT "fk_stock_balance_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_balance_godown"
          FOREIGN KEY ("godown_id") REFERENCES "godown" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_stock_balance_item"
          FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "stock_balance"`);
    await q.query(`DROP TRIGGER IF EXISTS "trg_stock_movement_append_only" ON "stock_movement"`);
    await q.query(`DROP TABLE IF EXISTS "stock_movement"`);
    await q.query(`DROP FUNCTION IF EXISTS ze_stock_movement_append_only()`);
  }
}
