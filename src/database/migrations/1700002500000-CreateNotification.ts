import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NTF — `notification` table (SRS 18 §8, FR-NTF-001/002/006/019). One append-only row per recipient
 * (fan-out); the only mutation is read-state. Unique (recipient_user_id, event_key) makes ingestion
 * idempotent; the (company_id, recipient_user_id, is_read, created_at DESC) index backs the feed +
 * unread count. FK to `user` ON DELETE CASCADE (a deleted user's notifications go with them). No
 * updated_at/deleted_at (retention purge is a later concern).
 */
export class CreateNotification1700002500000 implements MigrationInterface {
  name = 'CreateNotification1700002500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification" (
        "id"                  uuid         PRIMARY KEY,
        "company_id"          uuid         NOT NULL,
        "recipient_user_id"   uuid         NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "type"                varchar      NOT NULL,
        "severity"            varchar      NOT NULL,
        "title"               varchar      NOT NULL,
        "body"                text         NOT NULL DEFAULT '',
        "source_module"       varchar      NOT NULL,
        "source_entity_type"  varchar,
        "source_entity_id"    uuid,
        "deep_link"           jsonb,
        "payload"             jsonb        NOT NULL DEFAULT '{}'::jsonb,
        "event_key"           varchar      NOT NULL,
        "is_read"             boolean      NOT NULL DEFAULT false,
        "read_at"             timestamptz,
        "created_at"          timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "uq_notification_recipient_event" UNIQUE ("recipient_user_id", "event_key")
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_notification_feed" ON "notification" ("company_id", "recipient_user_id", "is_read", "created_at" DESC);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification";`);
  }
}
