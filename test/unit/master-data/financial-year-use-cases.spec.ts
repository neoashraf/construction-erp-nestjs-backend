/**
 * FinancialYear use-case tests with in-memory fakes (no DB) — create, set-active (exactly one active
 * per company), update + optimistic concurrency (FR-MAS-002, FR-MAS-003, FR-MAS-032).
 */
import { FinancialYear } from '../../../src/modules/master-data/financial-year/domain/financial-year';
import { FinancialYearRepository } from '../../../src/modules/master-data/financial-year/domain/ports/financial-year.repository';
import { CreateFinancialYearUseCase } from '../../../src/modules/master-data/application/financial-year/create-financial-year.use-case';
import { UpdateFinancialYearUseCase } from '../../../src/modules/master-data/application/financial-year/update-financial-year.use-case';
import { SetActiveFinancialYearUseCase } from '../../../src/modules/master-data/application/financial-year/set-active-financial-year.use-case';
import {
  AuditEntry,
  AuditService,
} from '../../../src/modules/master-data/application/ports/audit.port';
import {
  NotFoundError,
  OptimisticLockConflictError,
  ValidationError,
} from '../../../src/common/errors/domain-error';
import { UnitOfWork } from '../../../src/common/ports/unit-of-work.port';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const passthroughUow: UnitOfWork = { run: (work) => work() };

function seqIds(...ids: string[]): IdGenerator {
  let i = 0;
  return { next: () => ids[i++] ?? `fy-${i}` };
}

class FakeAudit implements AuditService {
  entries: AuditEntry[] = [];
  record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

class FakeFinancialYearRepo implements FinancialYearRepository {
  private store = new Map<string, FinancialYear>();
  findById(id: string, companyId: string): Promise<FinancialYear | null> {
    const fy = this.store.get(id);
    return Promise.resolve(fy && fy.props.companyId === companyId ? clone(fy, fy.version) : null);
  }
  findActive(companyId: string): Promise<FinancialYear | null> {
    for (const fy of this.store.values()) {
      if (fy.props.companyId === companyId && fy.isActive) return Promise.resolve(clone(fy, fy.version));
    }
    return Promise.resolve(null);
  }
  save(fy: FinancialYear): Promise<void> {
    const exists = this.store.has(fy.id);
    this.store.set(fy.id, clone(fy, exists ? fy.version + 1 : fy.version));
    return Promise.resolve();
  }
}

function clone(fy: FinancialYear, version: number): FinancialYear {
  return FinancialYear.rehydrate(fy.id, { ...fy.props, version });
}

const actor: Actor = { userId: 'u-1', companyId: 'co-1', financialYearId: '', role: 'Admin' };
const FY1 = { label: '2025-26', startDate: '2025-07-01', endDate: '2026-06-30' };
const FY2 = { label: '2026-27', startDate: '2026-07-01', endDate: '2027-06-30' };

describe('FinancialYear use cases', () => {
  let repo: FakeFinancialYearRepo;
  let audit: FakeAudit;

  beforeEach(() => {
    repo = new FakeFinancialYearRepo();
    audit = new FakeAudit();
  });

  it('creates an inactive financial year (FR-MAS-002)', async () => {
    const create = new CreateFinancialYearUseCase(repo, audit, passthroughUow, seqIds('fy-1'));
    const { id } = await create.execute(FY1, actor);
    const saved = await repo.findById(id, 'co-1');
    expect(saved?.isActive).toBe(false);
    expect(saved?.version).toBe(1);
    expect(audit.entries[0]).toMatchObject({ action: 'CREATE', entityType: 'FinancialYear' });
  });

  it('set-active marks exactly one active and clears the previous (FR-MAS-003)', async () => {
    const create = new CreateFinancialYearUseCase(repo, audit, passthroughUow, seqIds('fy-1', 'fy-2'));
    await create.execute(FY1, actor);
    await create.execute(FY2, actor);
    const setActive = new SetActiveFinancialYearUseCase(repo, audit, passthroughUow);

    await setActive.execute('fy-1', actor);
    expect((await repo.findActive('co-1'))?.id).toBe('fy-1');

    await setActive.execute('fy-2', actor);
    const active = await repo.findActive('co-1');
    expect(active?.id).toBe('fy-2');
    expect((await repo.findById('fy-1', 'co-1'))?.isActive).toBe(false);
  });

  it('set-active on an already-active year is a no-op', async () => {
    const create = new CreateFinancialYearUseCase(repo, audit, passthroughUow, seqIds('fy-1'));
    await create.execute(FY1, actor);
    const setActive = new SetActiveFinancialYearUseCase(repo, audit, passthroughUow);
    await setActive.execute('fy-1', actor);
    const auditCountAfterFirst = audit.entries.length;
    await setActive.execute('fy-1', actor); // already active
    expect(audit.entries.length).toBe(auditCountAfterFirst); // no new audit row
  });

  it('set-active on a missing year throws NotFoundError', async () => {
    const setActive = new SetActiveFinancialYearUseCase(repo, audit, passthroughUow);
    await expect(setActive.execute('nope', actor)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a stale-version update (FR-MAS-032)', async () => {
    const create = new CreateFinancialYearUseCase(repo, audit, passthroughUow, seqIds('fy-1'));
    await create.execute(FY1, actor);
    const update = new UpdateFinancialYearUseCase(repo, audit, passthroughUow);
    await update.execute('fy-1', { label: 'v2' }, 1, actor); // → version 2
    await expect(update.execute('fy-1', { label: 'v3' }, 1, actor)).rejects.toBeInstanceOf(
      OptimisticLockConflictError,
    );
  });

  it('rejects an update that breaks end_date > start_date (SRS §11)', async () => {
    const create = new CreateFinancialYearUseCase(repo, audit, passthroughUow, seqIds('fy-1'));
    await create.execute(FY1, actor);
    const update = new UpdateFinancialYearUseCase(repo, audit, passthroughUow);
    await expect(update.execute('fy-1', { endDate: '2025-01-01' }, 1, actor)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
