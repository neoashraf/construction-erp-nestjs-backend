import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AUD RBAC v2 — resource-level permissions + custom roles (FR-AUD-034/035, FR-AUD-030).
 *
 * A NEW migration on top of the shipped 1700000700000 (user) + 1700000800000 (role/permission) —
 * never edits them (their CHECK-enum constraints are immutable). Changes:
 *   - permission: `module` (module-enum CHECK) → `resource` (free varchar, app-validated against the
 *     Resource Catalogue); unique key (role_id, module, action) → (role_id, resource, action). Existing
 *     module-level rows are dropped (no 1:1 module→resource mapping) and re-created resource-level by the
 *     idempotent seed.
 *   - role: drop the six-name CHECK (name is now a free per-company-unique string); add `is_system`
 *     (built-in vs custom); mark the six seeded built-ins is_system=true; rename ACCOUNTS_TEAM → ACCOUNTS_MANAGER.
 *   - user: drop the six-role CHECK on `user.role`; migrate ACCOUNTS_TEAM rows → ACCOUNTS_MANAGER; add
 *     `must_change_password` (DEFAULT true — backs #38's forced-change gate).
 */
export class RbacV2ResourcePermissions1700002300000 implements MigrationInterface {
  name = 'RbacV2ResourcePermissions1700002300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── permission: module → resource ─────────────────────────────────────────
    // Drop stale module-level grants; the resource-level seed (seed-if-absent) recreates them.
    await queryRunner.query(`DELETE FROM "permission";`);
    await queryRunner.query(`ALTER TABLE "permission" DROP CONSTRAINT IF EXISTS "permission_module_check";`);
    await queryRunner.query(`ALTER TABLE "permission" DROP CONSTRAINT IF EXISTS "uq_permission_role_module_action";`);
    await queryRunner.query(`ALTER TABLE "permission" RENAME COLUMN "module" TO "resource";`);
    await queryRunner.query(
      `ALTER TABLE "permission" ADD CONSTRAINT "uq_permission_role_resource_action" UNIQUE ("role_id", "resource", "action");`,
    );

    // ── role: free-string name + is_system + rename ──────────────────────────
    await queryRunner.query(`ALTER TABLE "role" DROP CONSTRAINT IF EXISTS "role_name_check";`);
    await queryRunner.query(`ALTER TABLE "role" ADD COLUMN IF NOT EXISTS "is_system" boolean NOT NULL DEFAULT false;`);
    await queryRunner.query(`UPDATE "role" SET "name" = 'ACCOUNTS_MANAGER' WHERE "name" = 'ACCOUNTS_TEAM';`);
    await queryRunner.query(
      `UPDATE "role" SET "is_system" = true
       WHERE "name" IN ('ADMIN','PROJECT_MANAGER','SITE_ENGINEER','STORE_KEEPER','ACCOUNTS_MANAGER','HR_MANAGER');`,
    );

    // ── user: drop role CHECK, rename, add must_change_password ───────────────
    await queryRunner.query(`ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_role_check";`);
    await queryRunner.query(`UPDATE "user" SET "role" = 'ACCOUNTS_MANAGER' WHERE "role" = 'ACCOUNTS_TEAM';`);
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "must_change_password" boolean NOT NULL DEFAULT true;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // user
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS "must_change_password";`);
    await queryRunner.query(`UPDATE "user" SET "role" = 'ACCOUNTS_TEAM' WHERE "role" = 'ACCOUNTS_MANAGER';`);
    await queryRunner.query(
      `ALTER TABLE "user" ADD CONSTRAINT "user_role_check"
       CHECK ("role" IN ('ADMIN','PROJECT_MANAGER','SITE_ENGINEER','STORE_KEEPER','ACCOUNTS_TEAM','HR_MANAGER'));`,
    );

    // role
    await queryRunner.query(`UPDATE "role" SET "name" = 'ACCOUNTS_TEAM' WHERE "name" = 'ACCOUNTS_MANAGER';`);
    await queryRunner.query(`ALTER TABLE "role" DROP COLUMN IF EXISTS "is_system";`);
    await queryRunner.query(
      `ALTER TABLE "role" ADD CONSTRAINT "role_name_check"
       CHECK ("name" IN ('ADMIN','PROJECT_MANAGER','SITE_ENGINEER','STORE_KEEPER','ACCOUNTS_TEAM','HR_MANAGER'));`,
    );

    // permission
    await queryRunner.query(`DELETE FROM "permission";`);
    await queryRunner.query(`ALTER TABLE "permission" DROP CONSTRAINT IF EXISTS "uq_permission_role_resource_action";`);
    await queryRunner.query(`ALTER TABLE "permission" RENAME COLUMN "resource" TO "module";`);
    await queryRunner.query(
      `ALTER TABLE "permission" ADD CONSTRAINT "uq_permission_role_module_action" UNIQUE ("role_id", "module", "action");`,
    );
    await queryRunner.query(
      `ALTER TABLE "permission" ADD CONSTRAINT "permission_module_check"
       CHECK ("module" IN ('AUD','NUM','PER','LED','MAS','SAL','PUR','REQ','INV','REC','HR','PAY','GEN','RPT','DSH','CC'));`,
    );
  }
}
