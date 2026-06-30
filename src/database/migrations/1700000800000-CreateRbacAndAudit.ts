import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AUD rbac-and-audit — `role`, `permission`, `user_project`, `audit_log` tables.
 * Includes the audit_log BEFORE UPDATE OR DELETE append-only trigger (FR-AUD-023) and
 * the seal-chain support (FR-AUD-024). FK/CHECK constraints and indexes per §7.
 */
export class CreateRbacAndAudit1700000800000 implements MigrationInterface {
  name = 'CreateRbacAndAudit1700000800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── role ──────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "role" (
        "id"             uuid         PRIMARY KEY,
        "company_id"     uuid         NOT NULL REFERENCES "company"("id") ON DELETE RESTRICT,
        "name"           varchar      NOT NULL
                         CHECK ("name" IN ('ADMIN','PROJECT_MANAGER','SITE_ENGINEER','STORE_KEEPER','ACCOUNTS_TEAM','HR_MANAGER')),
        "approval_limit" numeric(18,4) CHECK ("approval_limit" >= 0),
        "is_unscoped"    boolean      NOT NULL DEFAULT false,
        "created_at"     timestamptz  NOT NULL DEFAULT now(),
        "updated_at"     timestamptz  NOT NULL DEFAULT now(),
        "version"        integer      NOT NULL DEFAULT 1,
        CONSTRAINT "uq_role_company_name" UNIQUE ("company_id", "name")
      );
    `);
    await queryRunner.query(`CREATE INDEX "idx_role_company" ON "role" ("company_id");`);

    // ── permission ────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "permission" (
        "id"            uuid         PRIMARY KEY,
        "role_id"       uuid         NOT NULL REFERENCES "role"("id") ON DELETE RESTRICT,
        "company_id"    uuid         NOT NULL,
        "module"        varchar      NOT NULL
                        CHECK ("module" IN ('AUD','NUM','PER','LED','MAS','SAL','PUR','REQ','INV','REC','HR','PAY','GEN','RPT','DSH','CC')),
        "action"        varchar      NOT NULL
                        CHECK ("action" IN ('CREATE','READ','UPDATE','DELETE','POST','CANCEL','APPROVE','REJECT')),
        "project_scope" varchar      NOT NULL DEFAULT 'ASSIGNED'
                        CHECK ("project_scope" IN ('ALL','ASSIGNED')),
        "value_limit"   numeric(18,4) CHECK ("value_limit" >= 0),
        "created_at"    timestamptz  NOT NULL DEFAULT now(),
        "updated_at"    timestamptz  NOT NULL DEFAULT now(),
        "version"       integer      NOT NULL DEFAULT 1,
        CONSTRAINT "uq_permission_role_module_action" UNIQUE ("role_id", "module", "action")
      );
    `);
    await queryRunner.query(`CREATE INDEX "idx_permission_role_id" ON "permission" ("role_id");`);

    // ── user_project ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "user_project" (
        "id"          uuid         PRIMARY KEY,
        "user_id"     uuid         NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
        "project_id"  uuid         NOT NULL REFERENCES "project"("id") ON DELETE RESTRICT,
        "company_id"  uuid         NOT NULL,
        "assigned_at" timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "uq_user_project" UNIQUE ("user_id", "project_id")
      );
    `);
    await queryRunner.query(`CREATE INDEX "idx_user_project_user" ON "user_project" ("user_id");`);

    // ── audit_log (append-only) ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id"           uuid         PRIMARY KEY,
        "company_id"   uuid         NOT NULL,
        "action"       varchar      NOT NULL
                       CHECK ("action" IN ('CREATE','UPDATE','DELETE','POST','CANCEL','APPROVE','REJECT','ACTIVATE','DEACTIVATE','READ')),
        "entity_type"  varchar      NOT NULL,
        "entity_id"    varchar      NOT NULL,
        "user_id"      uuid         NOT NULL,
        "before"       jsonb,
        "after"        jsonb,
        "ip_address"   varchar,
        "seal"         varchar      NOT NULL,
        "created_at"   timestamptz  NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_audit_log_company_entity" ON "audit_log" ("company_id", "entity_type", "entity_id");
      CREATE INDEX "idx_audit_log_user"           ON "audit_log" ("user_id");
      CREATE INDEX "idx_audit_log_created_at"     ON "audit_log" ("created_at");
      CREATE INDEX "idx_audit_log_company_created" ON "audit_log" ("company_id", "created_at");
    `);

    // ── append-only trigger (FR-AUD-023, ADR-0002 F2) ────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_log_no_mutate()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only: UPDATE and DELETE are not permitted';
      END;
      $$;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_log_no_mutate
      BEFORE UPDATE OR DELETE ON "audit_log"
      FOR EACH ROW EXECUTE FUNCTION audit_log_no_mutate();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_audit_log_no_mutate ON "audit_log";`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_log_no_mutate();`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_project";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "permission";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "role";`);
  }
}
