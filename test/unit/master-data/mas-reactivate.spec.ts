/**
 * Unit tests for FR-MAS-033 — reactivate deactivated masters (no DB, all deps mocked).
 * Covers: transition guard (isActive flip), version conflict, NOT_FOUND, audit record,
 * and PM project-scope enforcement on godown/purpose.
 */
import { ReactivateCostCentreUseCase } from '../../../src/modules/master-data/cost-centre/application/cost-centre.use-cases';
import { CostCentre } from '../../../src/modules/master-data/cost-centre/domain/cost-centre';
import { SetGodownActiveUseCase } from '../../../src/modules/master-data/godown/application/godown.use-cases';
import { Godown } from '../../../src/modules/master-data/godown/domain/godown';
import { SetPurposeActiveUseCase } from '../../../src/modules/master-data/purpose/application/purpose.use-cases';
import { Purpose } from '../../../src/modules/master-data/purpose/domain/purpose';
import { AccessPolicy, ForbiddenScopeError } from '../../../src/core/auth/domain/access-policy';
import { NotFoundError, OptimisticLockConflictError } from '../../../src/common/errors/domain-error';
import { AuditEntry, AuditService } from '../../../src/core/audit/application/audit.port';
import { UnitOfWork } from '../../../src/common/ports/unit-of-work.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

/* ─────────────────────────────── helpers ──────────────────────────────── */

const passthroughUow: UnitOfWork = { run: (work) => work() };
const policy = new AccessPolicy();

function fakeAudit(): AuditService & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { entries, record: (e) => { entries.push(e); return Promise.resolve(); } };
}

function adminActor(projectId?: string): Actor {
  return { userId: 'u-1', companyId: 'co-1', financialYearId: '', role: 'Admin', isUnscoped: true, assignedProjectIds: projectId ? [projectId] : [], approvalLimit: null };
}
function pmActor(assignedProjectIds: string[]): Actor {
  return { userId: 'u-2', companyId: 'co-1', financialYearId: '', role: 'Admin', isUnscoped: false, assignedProjectIds, approvalLimit: null };
}

/* ─────────────────────────────── cost-centre ──────────────────────────── */

function deactivatedCostCentre(id = 'cc-1'): CostCentre {
  const cc = CostCentre.rehydrate(id, { companyId: 'co-1', code: 'CC-EXC', name: 'Excavation', isActive: false, version: 2 });
  return cc;
}

function fakeCcRepo(cc: CostCentre | null = null) {
  return {
    findById: jest.fn().mockResolvedValue(cc),
    update: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn(),
    seedIfAbsent: jest.fn(),
  } as unknown as ConstructorParameters<typeof ReactivateCostCentreUseCase>[0];
}

describe('ReactivateCostCentreUseCase (FR-MAS-033)', () => {
  it('flips isActive from false to true and persists (FR-MAS-033)', async () => {
    const cc = deactivatedCostCentre();
    const repo = fakeCcRepo(cc);
    const audit = fakeAudit();
    const uc = new ReactivateCostCentreUseCase(repo, audit, passthroughUow);
    await uc.execute('cc-1', 2, adminActor());
    expect(cc.props.isActive).toBe(true);
    expect(repo.update).toHaveBeenCalledWith(cc, 2);
  });

  it('throws NOT_FOUND when the cost centre does not exist', async () => {
    const uc = new ReactivateCostCentreUseCase(fakeCcRepo(null), fakeAudit(), passthroughUow);
    await expect(uc.execute('cc-x', 1, adminActor())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws OPTIMISTIC_LOCK_CONFLICT on stale version (FR-MAS-032)', async () => {
    const cc = deactivatedCostCentre(); // version=2
    const uc = new ReactivateCostCentreUseCase(fakeCcRepo(cc), fakeAudit(), passthroughUow);
    await expect(uc.execute('cc-1', 1, adminActor())).rejects.toBeInstanceOf(OptimisticLockConflictError);
  });

  it('records a REACTIVATE audit entry (FR-MAS-031)', async () => {
    const cc = deactivatedCostCentre();
    const audit = fakeAudit();
    const uc = new ReactivateCostCentreUseCase(fakeCcRepo(cc), audit, passthroughUow);
    await uc.execute('cc-1', 2, adminActor());
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].action).toBe('REACTIVATE');
    expect(audit.entries[0].entityType).toBe('CostCentre');
    expect(audit.entries[0].entityId).toBe('cc-1');
  });
});

/* ─────────────────────────────── godown scope ─────────────────────────── */

function deactivatedGodown(projectId = 'proj-1', id = 'gd-1'): Godown {
  return Godown.rehydrate(id, { companyId: 'co-1', projectId, name: 'Main Store', location: null, isActive: false, version: 2 });
}

function fakeGodownRepo(g: Godown | null = null) {
  return {
    findById: jest.fn().mockResolvedValue(g),
    update: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn(),
  } as unknown as ConstructorParameters<typeof SetGodownActiveUseCase>[0];
}

describe('SetGodownActiveUseCase — project-scope (FR-MAS-033 / FR-AUD-014)', () => {
  it('Admin (isUnscoped) can reactivate any godown', async () => {
    const g = deactivatedGodown('proj-1');
    const uc = new SetGodownActiveUseCase(fakeGodownRepo(g), fakeAudit(), passthroughUow, policy);
    await expect(uc.execute('gd-1', 2, true, adminActor())).resolves.toBeUndefined();
    expect(g.props.isActive).toBe(true);
  });

  it('PM with the godown project in scope can reactivate', async () => {
    const g = deactivatedGodown('proj-assigned');
    const uc = new SetGodownActiveUseCase(fakeGodownRepo(g), fakeAudit(), passthroughUow, policy);
    await expect(uc.execute('gd-1', 2, true, pmActor(['proj-assigned']))).resolves.toBeUndefined();
  });

  it('PM without the godown project in scope → ForbiddenScopeError (FR-MAS-033)', async () => {
    const g = deactivatedGodown('proj-other');
    const uc = new SetGodownActiveUseCase(fakeGodownRepo(g), fakeAudit(), passthroughUow, policy);
    await expect(uc.execute('gd-1', 2, true, pmActor(['proj-mine']))).rejects.toBeInstanceOf(ForbiddenScopeError);
  });

  it('PM with empty project list cannot reactivate any godown', async () => {
    const g = deactivatedGodown('proj-1');
    const uc = new SetGodownActiveUseCase(fakeGodownRepo(g), fakeAudit(), passthroughUow, policy);
    await expect(uc.execute('gd-1', 2, true, pmActor([]))).rejects.toBeInstanceOf(ForbiddenScopeError);
  });

  it('throws OPTIMISTIC_LOCK_CONFLICT on stale version (FR-MAS-032)', async () => {
    const g = deactivatedGodown(); // version=2
    const uc = new SetGodownActiveUseCase(fakeGodownRepo(g), fakeAudit(), passthroughUow, policy);
    await expect(uc.execute('gd-1', 1, true, adminActor())).rejects.toBeInstanceOf(OptimisticLockConflictError);
  });

  it('records REACTIVATE audit entry (FR-MAS-031)', async () => {
    const g = deactivatedGodown('proj-1');
    const audit = fakeAudit();
    const uc = new SetGodownActiveUseCase(fakeGodownRepo(g), audit, passthroughUow, policy);
    await uc.execute('gd-1', 2, true, adminActor());
    expect(audit.entries[0].action).toBe('REACTIVATE');
    expect(audit.entries[0].entityType).toBe('Godown');
  });
});

/* ─────────────────────────────── purpose scope ────────────────────────── */

function deactivatedPurpose(projectId = 'proj-1', id = 'pur-1'): Purpose {
  return Purpose.rehydrate(id, { companyId: 'co-1', projectId, name: 'Structural', isActive: false, version: 2 });
}

function fakePurposeRepo(p: Purpose | null = null) {
  return {
    findById: jest.fn().mockResolvedValue(p),
    update: jest.fn().mockResolvedValue(undefined),
    findByNameCI: jest.fn(),
    tryInsert: jest.fn(),
  } as unknown as ConstructorParameters<typeof SetPurposeActiveUseCase>[0];
}

describe('SetPurposeActiveUseCase — project-scope (FR-MAS-033 / FR-AUD-014)', () => {
  it('Admin can reactivate any purpose', async () => {
    const p = deactivatedPurpose('proj-1');
    const uc = new SetPurposeActiveUseCase(fakePurposeRepo(p), fakeAudit(), passthroughUow, policy);
    await expect(uc.execute('pur-1', 2, true, adminActor())).resolves.toBeUndefined();
    expect(p.props.isActive).toBe(true);
  });

  it('PM with the purpose project in scope can reactivate', async () => {
    const p = deactivatedPurpose('proj-mine');
    const uc = new SetPurposeActiveUseCase(fakePurposeRepo(p), fakeAudit(), passthroughUow, policy);
    await expect(uc.execute('pur-1', 2, true, pmActor(['proj-mine']))).resolves.toBeUndefined();
  });

  it('PM without the purpose project in scope → ForbiddenScopeError (FR-MAS-033)', async () => {
    const p = deactivatedPurpose('proj-theirs');
    const uc = new SetPurposeActiveUseCase(fakePurposeRepo(p), fakeAudit(), passthroughUow, policy);
    await expect(uc.execute('pur-1', 2, true, pmActor(['proj-mine']))).rejects.toBeInstanceOf(ForbiddenScopeError);
  });

  it('records REACTIVATE audit entry (FR-MAS-031)', async () => {
    const p = deactivatedPurpose();
    const audit = fakeAudit();
    const uc = new SetPurposeActiveUseCase(fakePurposeRepo(p), audit, passthroughUow, policy);
    await uc.execute('pur-1', 2, true, adminActor());
    expect(audit.entries[0].action).toBe('REACTIVATE');
    expect(audit.entries[0].entityType).toBe('Purpose');
  });
});
