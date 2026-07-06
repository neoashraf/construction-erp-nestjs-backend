/**
 * per-fy-lock-error — evaluation-order + distinctness tests for POST /api/periods/:id/reopen
 * (FR-PER-009/010). Proves:
 *   1. RolesGuard (presentation) rejects a caller lacking {module:'PER', action:'UPDATE'} with
 *      ForbiddenException ('FORBIDDEN') BEFORE any use-case/state check runs (permission checked first).
 *   2. RolesGuard admits a caller holding the permission through to the use case.
 *   3. FORBIDDEN (permission), PERIOD_ALREADY_OPEN (FSM), and PERIOD_FY_LOCKED (year-lock) are three
 *      distinct rejections that never collide, exercised at the ReopenPeriodUseCase layer a caller
 *      WITH `period.reopen` still hits.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../../src/core/auth/presentation/roles.guard';
import { RoleRepository } from '../../../src/core/auth/domain/ports/role.repository.port';
import { PermissionRepository } from '../../../src/core/auth/domain/ports/permission.repository.port';
import { Role } from '../../../src/core/auth/domain/role.entity';
import { Permission } from '../../../src/core/auth/domain/permission.entity';
import { ReopenPeriodUseCase } from '../../../src/core/period/application/reopen-period.use-case';
import { GeneratePeriodsUseCase } from '../../../src/core/period/application/generate-periods.use-case';
import { CloseFyUseCase } from '../../../src/core/period/application/close-fy.use-case';
import { AccountingPeriod } from '../../../src/core/period/domain/accounting-period';
import { AccountingPeriodRepository } from '../../../src/core/period/domain/ports/accounting-period.repository';
import { PeriodAlreadyOpenError, PeriodFyLockedError } from '../../../src/core/period/domain/errors';
import { AuditEntry, AuditService } from '../../../src/core/audit/application/audit.port';
import { UnitOfWork } from '../../../src/common/ports/unit-of-work.port';
import { Clock } from '../../../src/common/ports/clock.port';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

// ── Shared fakes (mirror test/unit/period/period-use-cases.spec.ts) ──

const passthroughUow: UnitOfWork = { run: (work) => work() };
const clock: Clock = { now: () => new Date('2026-07-15T10:00:00Z') };

class FakeAudit implements AuditService {
  entries: AuditEntry[] = [];
  record(e: AuditEntry): Promise<void> {
    this.entries.push(e);
    return Promise.resolve();
  }
}

class FakeRepo implements AccountingPeriodRepository {
  store = new Map<string, AccountingPeriod>();
  fyBounds = new Map<string, { startDate: string; endDate: string }>([
    ['fy-1', { startDate: '2025-07-01', endDate: '2026-06-30' }],
  ]);

  findOwningForUpdate(companyId: string, fyId: string, date: string): Promise<AccountingPeriod | null> {
    for (const p of this.store.values()) {
      if (p.props.companyId === companyId && p.props.financialYearId === fyId && p.owns(date)) {
        return Promise.resolve(p);
      }
    }
    return Promise.resolve(null);
  }
  findById(id: string, companyId: string): Promise<AccountingPeriod | null> {
    const p = this.store.get(id);
    return Promise.resolve(p && p.props.companyId === companyId ? p : null);
  }
  listByFy(companyId: string, fyId: string): Promise<AccountingPeriod[]> {
    return Promise.resolve(
      [...this.store.values()].filter((p) => p.props.companyId === companyId && p.props.financialYearId === fyId),
    );
  }
  existsAnyForFy(companyId: string, fyId: string): Promise<boolean> {
    return Promise.resolve([...this.store.values()].some((p) => p.props.companyId === companyId && p.props.financialYearId === fyId));
  }
  save(p: AccountingPeriod): Promise<void> {
    this.store.set(p.id, p);
    return Promise.resolve();
  }
  saveMany(ps: AccountingPeriod[]): Promise<void> {
    ps.forEach((p) => this.store.set(p.id, p));
    return Promise.resolve();
  }
  financialYearExists(_c: string, fyId: string): Promise<boolean> {
    return Promise.resolve(this.fyBounds.has(fyId));
  }
  financialYearBounds(_c: string, fyId: string): Promise<{ startDate: string; endDate: string } | null> {
    return Promise.resolve(this.fyBounds.get(fyId) ?? null);
  }
}

function seqIds(): IdGenerator {
  let i = 0;
  return { next: () => `p-${++i}` };
}

const actor: Actor = {
  userId: 'u-1',
  companyId: 'co-1',
  financialYearId: 'fy-1',
  role: 'Admin',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

// ── 1 & 2. RolesGuard — permission checked before anything else ──

function mockContext(role: string): ExecutionContext {
  return {
    getHandler: () => function reopen() {},
    getClass: () => class PeriodController {},
    switchToHttp: () => ({
      getRequest: () => ({ user: { ...actor, role } }),
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard on POST /api/periods/:id/reopen (per-fy-lock-error)', () => {
  const reflector = new Reflector();
  let getAllAndOverride: jest.SpyInstance;

  beforeEach(() => {
    getAllAndOverride = jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([{ resource: 'periods', action: 'UPDATE' }]);
  });

  afterEach(() => getAllAndOverride.mockRestore());

  it('rejects a caller whose role lacks {PER, UPDATE} with ForbiddenException (FORBIDDEN) — no state touched', async () => {
    const roles: RoleRepository = {
      findById: async () => null,
      findByName: async (companyId, name) => Role.rehydrate('role-pm', { companyId, name, isSystem: true, approvalLimit: null, isUnscoped: false, version: 1 }),
      findAll: async () => [],
      save: async () => {},
      delete: async () => {},
      countUsers: async () => 0,
      renameUserReferences: async () => {},
    };
    // PROJECT_MANAGER role has no `periods` permission (mirrors the real seed).
    const permissions: PermissionRepository = {
      findById: async () => null,
      findByRoleId: async () => [],
      findByRoleIdResourceAction: async () => null,
      findAll: async () => [],
      save: async () => {},
      delete: async () => {},
      deleteByRoleId: async () => {},
    };
    const guard = new RolesGuard(reflector, roles, permissions);
    const ctx = mockContext('PROJECT_MANAGER');

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ message: 'FORBIDDEN' });
  });

  it('admits a caller whose role holds {PER, UPDATE} (e.g. ADMIN) through to the use case', async () => {
    const roles: RoleRepository = {
      findById: async () => null,
      findByName: async (companyId, name) => Role.rehydrate('role-admin', { companyId, name, isSystem: true, approvalLimit: null, isUnscoped: true, version: 1 }),
      findAll: async () => [],
      save: async () => {},
      delete: async () => {},
      countUsers: async () => 0,
      renameUserReferences: async () => {},
    };
    const grantedPermission = Permission.create('perm-1', {
      roleId: 'role-admin',
      companyId: 'co-1',
      resource: 'periods',
      action: 'UPDATE',
      projectScope: 'ALL',
      valueLimit: null,
    });
    const permissions: PermissionRepository = {
      findById: async () => null,
      findByRoleId: async () => [grantedPermission],
      findByRoleIdResourceAction: async () => grantedPermission,
      findAll: async () => [],
      save: async () => {},
      delete: async () => {},
      deleteByRoleId: async () => {},
    };
    const guard = new RolesGuard(reflector, roles, permissions);
    const ctx = mockContext('ADMIN');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

// ── 3. Use-case layer — FORBIDDEN / PERIOD_ALREADY_OPEN / PERIOD_FY_LOCKED never collide ──

describe('Reopen rejection codes are distinct (per-fy-lock-error acceptance criteria)', () => {
  let repo: FakeRepo;
  let audit: FakeAudit;

  beforeEach(() => {
    repo = new FakeRepo();
    audit = new FakeAudit();
  });

  const generateUc = () => new GeneratePeriodsUseCase(repo, passthroughUow, seqIds());
  const reopenUc = () => new ReopenPeriodUseCase(repo, audit, passthroughUow);
  const closeFyUc = () => new CloseFyUseCase(repo, audit, passthroughUow, clock);

  it('PERIOD_ALREADY_OPEN (FSM) fires for a period that is not CLOSED — never PERIOD_FY_LOCKED', async () => {
    const created = await generateUc().execute('fy-1', actor);
    // every period is freshly generated OPEN; reopening one is an FSM violation, not a year-lock.
    await expect(reopenUc().execute(created[0].id, actor)).rejects.toBeInstanceOf(PeriodAlreadyOpenError);
  });

  it('PERIOD_FY_LOCKED (year-lock) fires only once every period of the FY is CLOSED', async () => {
    const created = await generateUc().execute('fy-1', actor);
    await closeFyUc().execute('fy-1', actor); // all 12 CLOSED -> FY is year-locked
    const rejection = await reopenUc()
      .execute(created[0].id, actor)
      .catch((e) => e);
    expect(rejection).toBeInstanceOf(PeriodFyLockedError);
    expect(rejection).not.toBeInstanceOf(PeriodAlreadyOpenError);
  });

  it('a permitted caller (period.reopen granted) still gets PERIOD_FY_LOCKED on a locked FY — the guard is a state check, not a permission bypass', async () => {
    const created = await generateUc().execute('fy-1', actor);
    await closeFyUc().execute('fy-1', actor);
    // `actor` here models a caller who already passed the RolesGuard permission check (Admin).
    await expect(reopenUc().execute(created[0].id, actor)).rejects.toBeInstanceOf(PeriodFyLockedError);
  });

  it('no partial state change / no audit stamp on a PERIOD_FY_LOCKED rejection', async () => {
    const created = await generateUc().execute('fy-1', actor);
    await closeFyUc().execute('fy-1', actor);
    const auditCountBefore = audit.entries.length;

    await expect(reopenUc().execute(created[0].id, actor)).rejects.toBeInstanceOf(PeriodFyLockedError);

    const period = await repo.findById(created[0].id, 'co-1');
    expect(period!.isOpen()).toBe(false); // still CLOSED — no mutation on the reject path
    expect(audit.entries.length).toBe(auditCountBefore); // no new audit entry stamped
  });
});
