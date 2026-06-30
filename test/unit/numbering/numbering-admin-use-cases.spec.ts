/**
 * Numbering admin use-case tests with in-memory fakes (no DB) — create (cross-company / duplicate /
 * invalid type) and forward-only update + optimistic concurrency + audit (FR-NUM-001/002/018/020/022).
 */
import { CreateNumberingSeriesUseCase } from '../../../src/core/numbering/application/create-numbering-series.use-case';
import { UpdateNumberingSeriesUseCase } from '../../../src/core/numbering/application/update-numbering-series.use-case';
import {
  NewNumberingSeries,
  NumberingSeriesAdminRepository,
  NumberingSeriesRow,
} from '../../../src/core/numbering/domain/ports/numbering-series.repository';
import { AuditEntry, AuditService } from '../../../src/core/audit/application/audit.port';
import {
  CrossCompanyReferenceError,
  NotFoundError,
  OptimisticLockConflictError,
  SeriesAlreadyExistsError,
  ValidationError,
} from '../../../src/common/errors/domain-error';
import { UnitOfWork } from '../../../src/common/ports/unit-of-work.port';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const passthroughUow: UnitOfWork = { run: (work) => work() };
const fixedIds = (id: string): IdGenerator => ({ next: () => id });
const actor: Actor = { userId: 'u-1', companyId: 'co-1', financialYearId: 'fy-1', role: 'Admin', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };

class FakeAudit implements AuditService {
  entries: AuditEntry[] = [];
  record(e: AuditEntry): Promise<void> {
    this.entries.push(e);
    return Promise.resolve();
  }
}

class FakeRepo implements NumberingSeriesAdminRepository {
  rows = new Map<string, NumberingSeriesRow>();
  fyToCompany = new Map<string, string>([['fy-1', 'co-1']]);

  create(s: NewNumberingSeries): Promise<void> {
    for (const r of this.rows.values()) {
      if (r.companyId === s.companyId && r.financialYearId === s.financialYearId && r.voucherType === s.voucherType) {
        return Promise.reject(new SeriesAlreadyExistsError());
      }
    }
    this.rows.set(s.id, { ...s, lastSequence: 0, version: 1 });
    return Promise.resolve();
  }
  findById(id: string, companyId: string): Promise<NumberingSeriesRow | null> {
    const r = this.rows.get(id);
    return Promise.resolve(r && r.companyId === companyId ? { ...r } : null);
  }
  updateConfig(
    id: string,
    companyId: string,
    expectedVersion: number,
    patch: { prefix?: string; paddingWidth?: number },
  ): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.companyId !== companyId || r.version !== expectedVersion) return Promise.resolve(false);
    if (patch.prefix !== undefined) r.prefix = patch.prefix;
    if (patch.paddingWidth !== undefined) r.paddingWidth = patch.paddingWidth;
    r.version += 1;
    return Promise.resolve(true);
  }
  financialYearBelongsToCompany(fyId: string, companyId: string): Promise<boolean> {
    return Promise.resolve(this.fyToCompany.get(fyId) === companyId);
  }
}

describe('Numbering admin use cases', () => {
  let repo: FakeRepo;
  let audit: FakeAudit;

  beforeEach(() => {
    repo = new FakeRepo();
    audit = new FakeAudit();
  });

  function createUc(id = 's-1') {
    return new CreateNumberingSeriesUseCase(repo, audit, passthroughUow, fixedIds(id));
  }

  it('creates a series (lastSequence 0) and records a CREATE audit (FR-NUM-003/022)', async () => {
    const { id } = await createUc().execute({ financialYearId: 'fy-1', voucherType: 'SALES_IPC' }, actor);
    expect(id).toBe('s-1');
    expect(repo.rows.get('s-1')).toMatchObject({ prefix: 'IPC', paddingWidth: 4, lastSequence: 0 });
    expect(audit.entries[0]).toMatchObject({ action: 'CREATE', entityType: 'NumberingSeries' });
  });

  it('rejects an unknown voucher type (VALIDATION_ERROR)', async () => {
    await expect(createUc().execute({ financialYearId: 'fy-1', voucherType: 'NOPE' }, actor)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a financial year from another company (CROSS_COMPANY_REFERENCE)', async () => {
    await expect(
      createUc().execute({ financialYearId: 'fy-other', voucherType: 'SALES_IPC' }, actor),
    ).rejects.toBeInstanceOf(CrossCompanyReferenceError);
  });

  it('rejects a duplicate triple (SERIES_ALREADY_EXISTS)', async () => {
    await createUc('s-1').execute({ financialYearId: 'fy-1', voucherType: 'SALES_IPC' }, actor);
    await expect(
      createUc('s-2').execute({ financialYearId: 'fy-1', voucherType: 'SALES_IPC' }, actor),
    ).rejects.toBeInstanceOf(SeriesAlreadyExistsError);
  });

  it('forward-only update bumps version and audits (FR-NUM-020)', async () => {
    await createUc('s-1').execute({ financialYearId: 'fy-1', voucherType: 'SALES_IPC' }, actor);
    const update = new UpdateNumberingSeriesUseCase(repo, audit, passthroughUow);
    await update.execute('s-1', { prefix: 'IPC-A', paddingWidth: 5, version: 1 }, actor);
    expect(repo.rows.get('s-1')).toMatchObject({ prefix: 'IPC-A', paddingWidth: 5, version: 2 });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'UPDATE', entityType: 'NumberingSeries' });
  });

  it('rejects a stale-version update (OPTIMISTIC_LOCK_CONFLICT)', async () => {
    await createUc('s-1').execute({ financialYearId: 'fy-1', voucherType: 'SALES_IPC' }, actor);
    const update = new UpdateNumberingSeriesUseCase(repo, audit, passthroughUow);
    await expect(update.execute('s-1', { prefix: 'X', version: 99 }, actor)).rejects.toBeInstanceOf(
      OptimisticLockConflictError,
    );
  });

  it('update on a missing series throws NotFoundError', async () => {
    const update = new UpdateNumberingSeriesUseCase(repo, audit, passthroughUow);
    await expect(update.execute('nope', { prefix: 'X', version: 1 }, actor)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
