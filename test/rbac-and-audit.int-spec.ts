/**
 * Integration tests for rbac-and-audit (#9).
 *
 * Covers:
 *   AC1 – project-scope guard (assertProjectInScope, scopeProjectFilter)
 *   AC2 – audit append-only trigger rejects UPDATE and DELETE (FR-AUD-023)
 *   AC3 – audit entries commit atomically with the business write (FR-AUD-025)
 *   AC4 – seal chain is consistent (computeSeal deterministic + verifyChain)
 *   AC5 – replaceSet full-set project assign/remove
 *   AC6 – approval-limit guard (assertWithinApprovalLimit)
 *
 * FR-AUD-011..025.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { Actor } from '../src/core/tenancy/tenant-context';
import { AccessPolicy, ForbiddenScopeError, OverApprovalLimitError } from '../src/core/auth/domain/access-policy';
import { TypeOrmUserProjectRepository } from '../src/core/auth/infrastructure/typeorm-user-project.repository';
import { TypeOrmAuditLogRepository, computeSeal } from '../src/core/audit/infrastructure/typeorm-audit-log.repository';
import { RealAuditService } from '../src/core/audit/application/real-audit.service';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UserProjectOrmEntity } from '../src/core/auth/infrastructure/user-project.orm-entity';
import { AuditLogOrmEntity } from '../src/core/audit/infrastructure/audit-log.orm-entity';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-000000000ca1';
const CO_CHAIN = '00000000-0000-0000-0000-000000000ca2';
const USER_ID = '00000000-0000-0000-0000-0000000000b1';
const TARGET_USER = '00000000-0000-0000-0000-0000000000b9';
const PROJECT_A = '00000000-0000-0000-0000-00000000da01';
const PROJECT_B = '00000000-0000-0000-0000-00000000db01';

const adminActor: Actor = {
  userId: USER_ID,
  companyId: CO,
  financialYearId: '00000000-0000-0000-0000-0000000000f1',
  role: 'ADMIN',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

describe('RBAC + Audit (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let userProjectRepo: TypeOrmUserProjectRepository;
  let auditLogRepo: TypeOrmAuditLogRepository;
  let auditService: RealAuditService;
  let uow: TypeOrmUnitOfWork;
  let accessPolicy: AccessPolicy;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getFirstMappedPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      entities: [UserProjectOrmEntity, AuditLogOrmEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    // DDL — minimal schema for the tables under test
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS "user_project" (
        "id"          uuid        PRIMARY KEY,
        "user_id"     uuid        NOT NULL,
        "project_id"  uuid        NOT NULL,
        "company_id"  uuid        NOT NULL,
        "assigned_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_user_project" UNIQUE ("user_id", "project_id")
      )
    `);
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS "audit_log" (
        "id"          uuid        PRIMARY KEY,
        "company_id"  uuid        NOT NULL,
        "action"      varchar     NOT NULL,
        "entity_type" varchar     NOT NULL,
        "entity_id"   varchar     NOT NULL,
        "user_id"     uuid        NOT NULL,
        "before"      jsonb,
        "after"       jsonb,
        "ip_address"  varchar,
        "seal"        varchar     NOT NULL,
        "created_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Append-only trigger (FR-AUD-023)
    await dataSource.query(`
      CREATE OR REPLACE FUNCTION audit_log_no_mutate()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only: UPDATE and DELETE are not permitted';
      END; $$
    `);
    await dataSource.query(`
      CREATE TRIGGER trg_audit_log_no_mutate
      BEFORE UPDATE OR DELETE ON "audit_log"
      FOR EACH ROW EXECUTE FUNCTION audit_log_no_mutate()
    `);

    // Construct services directly (no NestJS DI)
    userProjectRepo = new TypeOrmUserProjectRepository(dataSource);
    auditLogRepo = new TypeOrmAuditLogRepository(dataSource);
    auditService = new RealAuditService(auditLogRepo);
    uow = new TypeOrmUnitOfWork(dataSource);
    accessPolicy = new AccessPolicy();
  });

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  // ── AC1: Project scope guard ──────────────────────────────────────────────

  describe('AC1 – AccessPolicy scope guard (FR-AUD-014/015)', () => {
    it('allows an unscoped actor to access any project', () => {
      expect(() => accessPolicy.assertProjectInScope(adminActor, PROJECT_A)).not.toThrow();
    });

    it('allows a scoped actor assigned to the project', () => {
      const pm: Actor = { ...adminActor, isUnscoped: false, assignedProjectIds: [PROJECT_A] };
      expect(() => accessPolicy.assertProjectInScope(pm, PROJECT_A)).not.toThrow();
    });

    it('rejects a scoped actor not assigned to the project', () => {
      const pm: Actor = { ...adminActor, isUnscoped: false, assignedProjectIds: [PROJECT_B] };
      expect(() => accessPolicy.assertProjectInScope(pm, PROJECT_A)).toThrow(ForbiddenScopeError);
    });

    it('scopeProjectFilter returns ALL for unscoped actor', () => {
      expect(accessPolicy.scopeProjectFilter(adminActor)).toBe('ALL');
    });

    it('scopeProjectFilter returns assigned ids for scoped actor', () => {
      const pm: Actor = { ...adminActor, isUnscoped: false, assignedProjectIds: [PROJECT_A] };
      const result = accessPolicy.scopeProjectFilter(pm) as { projectIds: string[] };
      expect(result.projectIds).toEqual([PROJECT_A]);
    });
  });

  // ── AC2: Audit append-only trigger (FR-AUD-023) ──────────────────────────

  describe('AC2 – audit_log append-only trigger (FR-AUD-023)', () => {
    let rowId: string;

    beforeAll(async () => {
      rowId = crypto.randomUUID();
      await dataSource.query(
        `INSERT INTO audit_log (id, company_id, action, entity_type, entity_id, user_id, seal)
         VALUES ($1, $2, 'CREATE', 'Role', 'x', $3, 'aaa')`,
        [rowId, CO, USER_ID],
      );
    });

    it('UPDATE is blocked by trigger', async () => {
      await expect(
        dataSource.query(`UPDATE audit_log SET action = 'UPDATE' WHERE id = $1`, [rowId]),
      ).rejects.toThrow(/append-only/i);
    });

    it('DELETE is blocked by trigger', async () => {
      await expect(
        dataSource.query(`DELETE FROM audit_log WHERE id = $1`, [rowId]),
      ).rejects.toThrow(/append-only/i);
    });
  });

  // ── AC3: Audit atomicity (FR-AUD-025) ────────────────────────────────────

  describe('AC3 – audit atomicity (FR-AUD-025)', () => {
    it('rolls back the audit entry when the UoW is aborted', async () => {
      const { total: before } = await auditLogRepo.query({ companyId: CO, page: 1, pageSize: 1 });

      await expect(
        uow.run(async () => {
          await auditService.record({
            action: 'CREATE',
            entityType: 'TestEntity',
            entityId: 'will-rollback',
            actorId: USER_ID,
            companyId: CO,
            before: null,
            after: { x: 1 },
          });
          throw new Error('forced rollback');
        }),
      ).rejects.toThrow('forced rollback');

      const { total: after } = await auditLogRepo.query({ companyId: CO, page: 1, pageSize: 1 });
      expect(after).toBe(before); // no new entry survived
    });

    it('commits the audit entry when the UoW succeeds', async () => {
      const { total: before } = await auditLogRepo.query({ companyId: CO, page: 1, pageSize: 1 });

      await uow.run(async () => {
        await auditService.record({
          action: 'CREATE',
          entityType: 'TestEntity',
          entityId: 'committed',
          actorId: USER_ID,
          companyId: CO,
          before: null,
          after: { committed: true },
        });
      });

      const { total: after } = await auditLogRepo.query({ companyId: CO, page: 1, pageSize: 1 });
      expect(after).toBe(before + 1);
    });
  });

  // ── AC4: Seal chain (FR-AUD-024) ─────────────────────────────────────────

  describe('AC4 – seal chain integrity (FR-AUD-024)', () => {
    it('computeSeal is deterministic', () => {
      const s1 = computeSeal('co', 'CREATE', 'Role', 'id1', 'u1', null, { x: 1 }, '2026-01-01', null);
      const s2 = computeSeal('co', 'CREATE', 'Role', 'id1', 'u1', null, { x: 1 }, '2026-01-01', null);
      expect(s1).toBe(s2);
      expect(s1).toHaveLength(64); // SHA-256 hex
    });

    it('computeSeal changes when any field changes', () => {
      const base = computeSeal('co', 'CREATE', 'Role', 'id1', 'u1', null, null, 'ts', null);
      expect(computeSeal('CO', 'CREATE', 'Role', 'id1', 'u1', null, null, 'ts', null)).not.toBe(base);
      expect(computeSeal('co', 'UPDATE', 'Role', 'id1', 'u1', null, null, 'ts', null)).not.toBe(base);
      expect(computeSeal('co', 'CREATE', 'Role', 'id1', 'u1', null, null, 'ts', 'PREV')).not.toBe(base);
    });

    it('verifyChain returns ok:true for all entries written by RealAuditService', async () => {
      for (const label of ['chain-entry-1', 'chain-entry-2', 'chain-entry-3']) {
        await uow.run(async () => {
          await auditService.record({
            action: 'CREATE',
            entityType: 'ChainTest',
            entityId: label,
            actorId: USER_ID,
            companyId: CO_CHAIN,
            before: null,
            after: { label },
          });
        });
      }
      const result = await auditLogRepo.verifyChain(CO_CHAIN);
      expect(result.ok).toBe(true);
    });
  });

  // ── AC5: replaceSet full-set project assignment (FR-AUD-017) ─────────────

  describe('AC5 – UserProjectRepository.replaceSet (FR-AUD-017)', () => {
    it('adds both projects on first call', async () => {
      const { added, removed } = await userProjectRepo.replaceSet(TARGET_USER, CO, [PROJECT_A, PROJECT_B]);
      expect(added).toContain(PROJECT_A);
      expect(added).toContain(PROJECT_B);
      expect(removed).toHaveLength(0);
    });

    it('removes PROJECT_B when new set is [PROJECT_A]', async () => {
      const { added, removed } = await userProjectRepo.replaceSet(TARGET_USER, CO, [PROJECT_A]);
      expect(added).toHaveLength(0);
      expect(removed).toContain(PROJECT_B);
    });

    it('findByUserId reflects the current assignment', async () => {
      const rows = await userProjectRepo.findByUserId(TARGET_USER);
      expect(rows.map(r => r.props.projectId)).toEqual([PROJECT_A]);
    });

    it('clears all assignments on empty set', async () => {
      const { removed } = await userProjectRepo.replaceSet(TARGET_USER, CO, []);
      expect(removed).toContain(PROJECT_A);
      const rows = await userProjectRepo.findByUserId(TARGET_USER);
      expect(rows).toHaveLength(0);
    });
  });

  // ── AC6: Approval-limit guard (FR-AUD-016) ───────────────────────────────

  describe('AC6 – AccessPolicy.assertWithinApprovalLimit (FR-AUD-016)', () => {
    it('throws when approvalLimit is null (no approval authority = escalate)', () => {
      // null = no approval authority; every value must escalate
      expect(() => accessPolicy.assertWithinApprovalLimit(adminActor, new Decimal('0.0001'))).toThrow(OverApprovalLimitError);
    });

    it('passes when value equals the limit (greaterThan is strict)', () => {
      const actor: Actor = { ...adminActor, approvalLimit: new Decimal('50000') };
      expect(() => accessPolicy.assertWithinApprovalLimit(actor, new Decimal('50000.0000'))).not.toThrow();
    });

    it('passes when value is strictly below the limit', () => {
      const actor: Actor = { ...adminActor, approvalLimit: new Decimal('50000') };
      expect(() => accessPolicy.assertWithinApprovalLimit(actor, new Decimal('49999.9999'))).not.toThrow();
    });

    it('throws when value exceeds limit', () => {
      const actor: Actor = { ...adminActor, approvalLimit: new Decimal('50000') };
      expect(() => accessPolicy.assertWithinApprovalLimit(actor, new Decimal('50000.0001'))).toThrow(OverApprovalLimitError);
    });
  });
});
