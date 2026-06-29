import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline migration — intentionally a NO-OP.
 *
 * This brief (backend-scaffold) ships NO business tables; its job is to prove the migration tooling
 * works end-to-end. Running it records a row in `typeorm_migrations`; reverting removes it. The first
 * real schema (the ledger, 02-LED) arrives in a later migration that never edits this one.
 */
export class InitialBaseline1700000000000 implements MigrationInterface {
  name = 'InitialBaseline1700000000000';

  public async up(_queryRunner: QueryRunner): Promise<void> {
    // no-op: scaffold establishes the migrations table + tooling only.
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no-op: nothing to undo.
  }
}
