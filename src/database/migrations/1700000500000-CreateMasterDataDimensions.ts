import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MAS posting-dimension masters (FR-MAS-005..016). Raw SQL, `synchronize:false`. Creates project,
 * cost_centre, purpose, godown, project_budget with the §7 uniqueness constraints + indexes + FKs
 * (ON DELETE RESTRICT) + version. customer_id (Party) / project_manager_id (User) FKs are deferred to
 * the parties/AUD briefs; journal_line dimension FKs likewise (added once all masters exist).
 */
export class CreateMasterDataDimensions1700000500000 implements MigrationInterface {
  name = 'CreateMasterDataDimensions1700000500000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "cost_centre" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL,
        "code" varchar NOT NULL, "name" varchar NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "uq_cost_centre_code" UNIQUE ("company_id", "code"),
        CONSTRAINT "fk_cost_centre_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "idx_cost_centre_company" ON "cost_centre" ("company_id")`);

    await q.query(`
      CREATE TABLE "project" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL,
        "project_code" varchar NOT NULL, "name" varchar NOT NULL, "location" text,
        "customer_id" uuid NOT NULL, "project_manager_id" uuid NOT NULL,
        "start_date" date NOT NULL, "expected_end_date" date NOT NULL, "actual_end_date" date,
        "status" varchar NOT NULL DEFAULT 'PLANNED',
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "uq_project_code" UNIQUE ("company_id", "project_code"),
        CONSTRAINT "chk_project_dates" CHECK ("expected_end_date" > "start_date"),
        CONSTRAINT "fk_project_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "idx_project_company" ON "project" ("company_id")`);
    await q.query(`CREATE INDEX "idx_project_company_status" ON "project" ("company_id", "status")`);

    await q.query(`
      CREATE TABLE "purpose" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL, "project_id" uuid NOT NULL,
        "name" varchar NOT NULL, "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "fk_purpose_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_purpose_project" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_purpose_project_name" ON "purpose" ("project_id", lower("name"))`);
    await q.query(`CREATE INDEX "idx_purpose_project" ON "purpose" ("project_id")`);

    await q.query(`
      CREATE TABLE "godown" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL, "project_id" uuid NOT NULL,
        "name" varchar NOT NULL, "location" text, "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "uq_godown_project_name" UNIQUE ("project_id", "name"),
        CONSTRAINT "fk_godown_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_godown_project" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "idx_godown_project" ON "godown" ("project_id")`);

    await q.query(`
      CREATE TABLE "project_budget" (
        "id" uuid PRIMARY KEY, "company_id" uuid NOT NULL, "project_id" uuid NOT NULL, "cost_centre_id" uuid NOT NULL,
        "budgeted_amount" numeric(18,4) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid, "updated_by" uuid, "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "uq_project_budget_pair" UNIQUE ("project_id", "cost_centre_id"),
        CONSTRAINT "chk_project_budget_amount" CHECK ("budgeted_amount" >= 0),
        CONSTRAINT "fk_project_budget_company" FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_budget_project" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_budget_cost_centre" FOREIGN KEY ("cost_centre_id") REFERENCES "cost_centre" ("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "idx_project_budget_project" ON "project_budget" ("project_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "project_budget"`);
    await q.query(`DROP TABLE IF EXISTS "godown"`);
    await q.query(`DROP TABLE IF EXISTS "purpose"`);
    await q.query(`DROP TABLE IF EXISTS "project"`);
    await q.query(`DROP TABLE IF EXISTS "cost_centre"`);
  }
}
