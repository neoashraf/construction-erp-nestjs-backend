import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AUD auth-jwt — `user` + `refresh_token` tables (FR-AUD-001..009).
 * - `user`: email unique per company_id; password_hash never returned; role varchar (six-role enum);
 *   lockout fields (failed_login_attempts + locked_until); FKs ON DELETE RESTRICT to company + fy.
 * - `refresh_token`: server-side JTI allowlist; ON DELETE CASCADE from user (clean up on hard delete).
 */
export class CreateUser1700000700000 implements MigrationInterface {
  name = 'CreateUser1700000700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user" (
        "id"                      uuid         PRIMARY KEY,
        "company_id"              uuid         NOT NULL REFERENCES "company"("id") ON DELETE RESTRICT,
        "financial_year_id"       uuid         NOT NULL REFERENCES "financial_year"("id") ON DELETE RESTRICT,
        "email"                   varchar      NOT NULL,
        "password_hash"           varchar      NOT NULL,
        "name"                    varchar      NOT NULL,
        "role"                    varchar      NOT NULL
                                  CHECK ("role" IN (
                                    'ADMIN','PROJECT_MANAGER','SITE_ENGINEER',
                                    'STORE_KEEPER','ACCOUNTS_TEAM','HR_MANAGER'
                                  )),
        "is_active"               boolean      NOT NULL DEFAULT true,
        "last_login_at"           timestamptz,
        "phone"                   varchar,
        "failed_login_attempts"   integer      NOT NULL DEFAULT 0,
        "locked_until"            timestamptz,
        "created_at"              timestamptz  NOT NULL DEFAULT now(),
        "updated_at"              timestamptz  NOT NULL DEFAULT now(),
        "version"                 integer      NOT NULL DEFAULT 1,
        CONSTRAINT "uq_user_company_email" UNIQUE ("company_id", "email")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_user_company"       ON "user" ("company_id");
      CREATE INDEX "idx_user_company_email" ON "user" ("company_id", "email");
    `);

    await queryRunner.query(`
      CREATE TABLE "refresh_token" (
        "id"          uuid         PRIMARY KEY,
        "jti"         varchar      NOT NULL,
        "user_id"     uuid         NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "company_id"  uuid         NOT NULL,
        "expires_at"  timestamptz  NOT NULL,
        "revoked_at"  timestamptz,
        "created_at"  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "uq_refresh_token_jti" UNIQUE ("jti")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_refresh_token_user" ON "refresh_token" ("user_id");
      CREATE INDEX "idx_refresh_token_jti"  ON "refresh_token" ("jti");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_token";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user";`);
  }
}
