import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `checkin_log` — RAW punches pushed by a ZKTeco-style fingerprint device to `/iclock/cdata`
 * (SUPPORTING_APIS_GUIDE §5). Append-only device audit trail.
 *
 * THIS IS NOT A SECOND ATTENDANCE SOURCE OF TRUTH. `attendance_record` (mode = OFFICE) stays the
 * authoritative day-level attendance the reports and payroll read; ingestion reconciles each day's
 * punches into that row (check_in = first punch, check_out = last punch). `checkin_log` keeps the raw
 * detail — every individual punch, what the device actually sent — which the day-level row cannot hold.
 *
 * `device_timestamp` is TEXT, exactly as the source project stores it, and deliberately so: the device
 * sends wall-clock local time with no zone. Zero-padded `'YYYY-MM-DD HH:mm:ss'` means lexicographic
 * comparison IS chronological comparison, `MIN`/`MAX` give the day's first/last punch, and `substring(…,
 * 1, 10)` is the calendar date — with no timezone conversion anywhere to get wrong. `occurred_at` is a
 * parsed convenience copy; nothing derives attendance from it.
 *
 * `company_id` is resolved at ingestion from the device serial (`device_sn`), because the device itself
 * knows nothing about tenancy — see `DeviceIngestionService`.
 *
 * DUPLICATE PROTECTION: unique (company_id, user_id, device_timestamp). The source project omitted this
 * and noted that a re-sent batch inserts duplicates; here a replayed batch is idempotent instead. The
 * ingestion insert uses ON CONFLICT DO NOTHING, so a retrying device never doubles a punch.
 */
export class CreateCheckinLog1784800000000 implements MigrationInterface {
  name = 'CreateCheckinLog1784800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "checkin_log" (
        "id"               uuid PRIMARY KEY,
        "company_id"       uuid NOT NULL,
        "source_type"      varchar NOT NULL,
        "user_id"          varchar NOT NULL,
        "device_timestamp" varchar NOT NULL,
        "status"           varchar NOT NULL DEFAULT '0',
        "device_sn"        varchar,
        "occurred_at"      timestamptz,
        "received_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_checkin_log_company_user_ts"
          UNIQUE ("company_id", "user_id", "device_timestamp"),
        CONSTRAINT "fk_checkin_log_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT
      )
    `);
    // The reconciliation scan is (company, user, device_timestamp range); the received_at index backs
    // "latest ingested punch" for /api/sync/status.
    await q.query(
      `CREATE INDEX "idx_checkin_log_company_user_ts" ON "checkin_log" ("company_id", "user_id", "device_timestamp")`,
    );
    await q.query(
      `CREATE INDEX "idx_checkin_log_received_at" ON "checkin_log" ("received_at" DESC)`,
    );

    // Maps a device serial to the company (and default project) its punches belong to. Without a row
    // here a device's punches cannot be attributed, so ingestion records them as unmapped rather than
    // guessing a tenant.
    await q.query(`
      CREATE TABLE "attendance_device" (
        "id"                 uuid PRIMARY KEY,
        "company_id"         uuid NOT NULL,
        "device_sn"          varchar NOT NULL,
        "label"              varchar,
        "default_project_id" uuid,
        "is_active"          boolean NOT NULL DEFAULT true,
        "last_seen_at"       timestamptz,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_attendance_device_sn" UNIQUE ("device_sn"),
        CONSTRAINT "fk_attendance_device_company"
          FOREIGN KEY ("company_id") REFERENCES "company" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_attendance_device_project"
          FOREIGN KEY ("default_project_id") REFERENCES "project" ("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "idx_attendance_device_company" ON "attendance_device" ("company_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "attendance_device"`);
    await q.query(`DROP TABLE IF EXISTS "checkin_log"`);
  }
}
