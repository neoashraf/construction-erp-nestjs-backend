import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends audit_log_action_check to allow the 'REACTIVATE' action.
 *
 * Every master reactivate use case (cost centre, item, party, purpose, godown, account,
 * HR employee) records action 'REACTIVATE' via RealAuditService INSIDE the mutation's
 * transaction. The action was declared in the AuditService port but never added to the DB
 * CHECK constraint (the 'EXPORT' migration added EXPORT but not REACTIVATE), so the audit
 * INSERT violated audit_log_action_check and rolled the whole reactivate back as a 500
 * INTERNAL_ERROR. Deactivate was unaffected because 'DEACTIVATE' was already allowed.
 */
export class AddReactivateActionToAuditLog1784631745453 implements MigrationInterface {
  name = 'AddReactivateActionToAuditLog1784631745453';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_action_check";`);
    await queryRunner.query(`
      ALTER TABLE "audit_log"
      ADD CONSTRAINT "audit_log_action_check"
      CHECK ("action" IN ('CREATE','UPDATE','DELETE','POST','CANCEL','APPROVE','REJECT','ACTIVATE','DEACTIVATE','REACTIVATE','READ','EXPORT'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_action_check";`);
    await queryRunner.query(`
      ALTER TABLE "audit_log"
      ADD CONSTRAINT "audit_log_action_check"
      CHECK ("action" IN ('CREATE','UPDATE','DELETE','POST','CANCEL','APPROVE','REJECT','ACTIVATE','DEACTIVATE','READ','EXPORT'));
    `);
  }
}
