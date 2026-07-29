import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `checkin_log.project_id` — WHERE a punch happened (FR-HR-004, FR-HR-008).
 *
 * Nullable on purpose: a device punch knows only its machine, so the project is resolved from the
 * device row; only an explicit manual entry or an imported `Location` cell can name a project on the
 * punch itself. NULL therefore means "not stated", never "no project", and reconciliation falls
 * through to the device default and then the employee default (design §5.1).
 *
 * The column is additive and nullable, so every punch already stored keeps reading exactly as it did
 * — the reorder that consumes it can only affect rows created after this lands.
 */
export class AddCheckinLogProject1784900000000 implements MigrationInterface {
  name = 'AddCheckinLogProject1784900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "checkin_log" ADD COLUMN "project_id" uuid`);
    await q.query(`
      ALTER TABLE "checkin_log"
        ADD CONSTRAINT "fk_checkin_log_project"
        FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "checkin_log" DROP CONSTRAINT IF EXISTS "fk_checkin_log_project"`);
    await q.query(`ALTER TABLE "checkin_log" DROP COLUMN IF EXISTS "project_id"`);
  }
}
