import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MAS reference masters — Chart of Accounts, Parties, Items (FR-MAS-017..027, FR-MAS-033/034).
 * Raw SQL, `synchronize:false`. Creates account_group, account, party, item, item_uom_conversion with
 * the §7 uniqueness constraints + indexes + FKs (ON DELETE RESTRICT) + version.
 *
 * account.type / account_group.type are app-checked varchars (NOT a PG enum) so the value set stays
 * code-only. The account.type == group.type rule is enforced in the use case (design §7 leaves the
 * belt-and-suspenders DB trigger out of this slice). journal_line.account_id / item stock FKs are
 * deferred to their owning briefs (LED back-fill / INV).
 */
export class CreateMasterDataAccountsPartiesItems1700000600000 implements MigrationInterface {
  name = 'CreateMasterDataAccountsPartiesItems1700000600000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "account_group" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL,
        "name" varchar NOT NULL, "parent_group_id" uuid,
        "type" varchar NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_account_group_type" CHECK ("type" IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
        CONSTRAINT "fk_account_group_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_account_group_parent" FOREIGN KEY ("parent_group_id") REFERENCES "account_group" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "idx_account_group_company" ON "account_group" ("company_id")`);
    await q.query(`CREATE INDEX "idx_account_group_parent" ON "account_group" ("parent_group_id")`);

    await q.query(`
      CREATE TABLE "account" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL,
        "code" varchar NOT NULL, "name" varchar NOT NULL,
        "account_group_id" uuid NOT NULL, "type" varchar NOT NULL,
        "opening_balance" numeric(18,4),
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "uq_account_code" UNIQUE ("company_id", "code"),
        CONSTRAINT "chk_account_type" CHECK ("type" IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
        CONSTRAINT "fk_account_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_account_group" FOREIGN KEY ("account_group_id") REFERENCES "account_group" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "idx_account_company" ON "account" ("company_id")`);
    await q.query(`CREATE INDEX "idx_account_group_id" ON "account" ("account_group_id")`);

    await q.query(`
      CREATE TABLE "party" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL,
        "name" varchar NOT NULL,
        "is_customer" boolean NOT NULL DEFAULT false, "is_supplier" boolean NOT NULL DEFAULT false,
        "tin" varchar, "bin" varchar, "address" text,
        "phone" varchar NOT NULL, "email" varchar,
        "payment_terms_days" integer NOT NULL DEFAULT 0,
        "opening_balance" numeric(18,4),
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_party_role" CHECK ("is_customer" = true OR "is_supplier" = true),
        CONSTRAINT "chk_party_payment_terms" CHECK ("payment_terms_days" >= 0),
        CONSTRAINT "fk_party_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "idx_party_company" ON "party" ("company_id")`);
    await q.query(`CREATE INDEX "idx_party_company_roles" ON "party" ("company_id", "is_customer", "is_supplier")`);

    await q.query(`
      CREATE TABLE "item" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL,
        "code" varchar NOT NULL, "name" varchar NOT NULL,
        "base_uom" varchar NOT NULL, "hs_code" varchar,
        "default_account_id" uuid NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "uq_item_code" UNIQUE ("company_id", "code"),
        CONSTRAINT "fk_item_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_item_default_account" FOREIGN KEY ("default_account_id") REFERENCES "account" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "idx_item_company" ON "item" ("company_id")`);

    await q.query(`
      CREATE TABLE "item_uom_conversion" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL, "item_id" uuid NOT NULL,
        "uom" varchar NOT NULL, "factor_to_base" numeric(18,4) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "uq_item_uom" UNIQUE ("item_id", "uom"),
        CONSTRAINT "chk_item_uom_factor" CHECK ("factor_to_base" > 0),
        CONSTRAINT "fk_item_uom_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_item_uom_item" FOREIGN KEY ("item_id") REFERENCES "item" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "idx_item_uom_item" ON "item_uom_conversion" ("item_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "item_uom_conversion"`);
    await q.query(`DROP TABLE IF EXISTS "item"`);
    await q.query(`DROP TABLE IF EXISTS "party"`);
    await q.query(`DROP TABLE IF EXISTS "account"`);
    await q.query(`DROP TABLE IF EXISTS "account_group"`);
  }
}
