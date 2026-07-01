import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends audit_log_action_check to allow the 'EXPORT' action (FR-AUD-028).
 * The export endpoint self-logs via RealAuditService, which requires the action to be valid.
 */
export class AddExportActionToAuditLog1700000900000 implements MigrationInterface {
  name = 'AddExportActionToAuditLog1700000900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_action_check";`);
    await queryRunner.query(`
      ALTER TABLE "audit_log"
      ADD CONSTRAINT "audit_log_action_check"
      CHECK ("action" IN ('CREATE','UPDATE','DELETE','POST','CANCEL','APPROVE','REJECT','ACTIVATE','DEACTIVATE','READ','EXPORT'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_action_check";`);
    await queryRunner.query(`
      ALTER TABLE "audit_log"
      ADD CONSTRAINT "audit_log_action_check"
      CHECK ("action" IN ('CREATE','UPDATE','DELETE','POST','CANCEL','APPROVE','REJECT','ACTIVATE','DEACTIVATE','READ'));
    `);
  }
}
