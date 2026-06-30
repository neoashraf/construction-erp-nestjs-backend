/**
 * PER use-case tests with in-memory fakes (no DB) — assertOpen OPEN/CLOSED/no-period; generate
 * idempotency + FY-not-found; close/reopen + year-lock; close-fy batch (FR-PER-002/005/006/008/009/010).
 */
import { PeriodServiceImpl } from '../../../src/core/period/application/period.service';
import { GeneratePeriodsUseCase } from '../../../src/core/period/application/generate-periods.use-case';
import { ClosePeriodUseCase } from '../../../src/core/period/application/close-period.use-case';
import { ReopenPeriodUseCase } from '../../../src/core/period/application/reopen-period.use-case';
import { CloseFyUseCase } from '../../../src/core/period/application/close-fy.use-case';
import { AccountingPeriod } from '../../../src/core/period/domain/accounting-period';
import { AccountingPeriodRepository } from '../../../src/core/period/domain/ports/accounting-period.repository';
import {
  FinancialYearNotFoundError,
  NoPeriodDefinedError,
  PeriodClosedError,
  PeriodFyLockedError,
  PeriodsAlreadyExistError,
} from '../../../src/core/period/domain/errors';
import { AuditEntry, AuditService } from '../../../src/core/audit/application/audit.port';
import { UnitOfWork } from '../../../src/common/ports/unit-of-work.port';
import { Clock } from '../../../src/common/ports/clock.port';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const passthroughUow: UnitOfWork = { run: (work) => work() };
const clock: Clock = { now: () => new Date('2026-07-15T10:00:00Z') };
const actor: Actor = { userId: 'u-1', companyId: 'co-1', financialYearId: 'fy-1', role: 'Admin', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };

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

describe('PER use cases', () => {
  let repo: FakeRepo;
  let audit: FakeAudit;

  beforeEach(() => {
    repo = new FakeRepo();
    audit = new FakeAudit();
  });

  const generateUc = () => new GeneratePeriodsUseCase(repo, passthroughUow, seqIds());
  const closeUc = () => new ClosePeriodUseCase(repo, audit, passthroughUow, clock);
  const reopenUc = () => new ReopenPeriodUseCase(repo, audit, passthroughUow);
  const closeFyUc = () => new CloseFyUseCase(repo, audit, passthroughUow, clock);

  it('generate creates 12 OPEN months; a second generate is rejected (FR-PER-002)', async () => {
    const created = await generateUc().execute('fy-1', actor);
    expect(created).toHaveLength(12);
    expect(created.every((p) => p.isOpen())).toBe(true);
    await expect(generateUc().execute('fy-1', actor)).rejects.toBeInstanceOf(PeriodsAlreadyExistError);
  });

  it('generate on an unknown FY throws FinancialYearNotFoundError', async () => {
    await expect(generateUc().execute('fy-x', actor)).rejects.toBeInstanceOf(FinancialYearNotFoundError);
  });

  it('assertOpen returns for OPEN, throws PERIOD_CLOSED for closed, NO_PERIOD_DEFINED for undefined', async () => {
    await generateUc().execute('fy-1', actor);
    const svc = new PeriodServiceImpl(repo);
    await expect(svc.assertOpen('co-1', 'fy-1', '2025-07-15')).resolves.toBeUndefined();

    // close the Jul period then re-check
    const jul = (await repo.listByFy('co-1', 'fy-1')).find((p) => p.owns('2025-07-15'))!;
    await closeUc().execute(jul.id, actor);
    await expect(svc.assertOpen('co-1', 'fy-1', '2025-07-15')).rejects.toBeInstanceOf(PeriodClosedError);

    // a date outside any generated period
    await expect(svc.assertOpen('co-1', 'fy-1', '2030-01-01')).rejects.toBeInstanceOf(NoPeriodDefinedError);
  });

  it('close stamps + audits; reopen clears + audits (one OPEN sibling → not year-locked)', async () => {
    await generateUc().execute('fy-1', actor);
    const periods = await repo.listByFy('co-1', 'fy-1');
    await closeUc().execute(periods[0].id, actor);
    expect(periods[0].isOpen()).toBe(false);
    expect(audit.entries.at(-1)).toMatchObject({ entityType: 'AccountingPeriod' });

    await reopenUc().execute(periods[0].id, actor); // other 11 still OPEN → allowed
    expect(periods[0].isOpen()).toBe(true);
  });

  it('close-fy closes every OPEN period and then reopen is blocked (year-locked) (FR-PER-010)', async () => {
    await generateUc().execute('fy-1', actor);
    const result = await closeFyUc().execute('fy-1', actor);
    expect(result.closedCount).toBe(12);
    expect(result.alreadyClosedCount).toBe(0);

    const periods = await repo.listByFy('co-1', 'fy-1');
    expect(periods.every((p) => !p.isOpen())).toBe(true);
    await expect(reopenUc().execute(periods[0].id, actor)).rejects.toBeInstanceOf(PeriodFyLockedError);
  });
});
