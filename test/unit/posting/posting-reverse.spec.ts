/**
 * PostingService.reverse use-case tests with fakes (no DB) — AC1 (swaps + links, original untouched),
 * AC2 (already-reversed / reverse-a-reversal), AC3 (closed period/project → numbering never called).
 */
import { PostingService } from '../../../src/core/posting/application/posting.service';
import { JournalEntry } from '../../../src/core/posting/domain/journal-entry';
import { JournalEntryRepository } from '../../../src/core/posting/domain/ports/journal-entry.repository';
import { NumberingService } from '../../../src/core/posting/domain/ports/numbering.service';
import { PeriodService } from '../../../src/core/posting/domain/ports/period.service';
import { ProjectStatusService } from '../../../src/core/posting/domain/ports/project-status.service';
import { MasterLookupService } from '../../../src/core/posting/domain/ports/master-lookup.service';
import { OverviewTagMatrix } from '../../../src/core/posting/domain/tag-matrix';
import {
  AlreadyReversedError,
  CannotReverseReversalError,
  ProjectClosedError,
} from '../../../src/core/posting/domain/errors';
import { PeriodClosedError } from '../../../src/core/period/domain/errors';
import { Money } from '../../../src/common/money';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Clock } from '../../../src/common/ports/clock.port';

const clock: Clock = { now: () => new Date('2026-07-15T10:00:00Z') };

function seqIds(...ids: string[]): IdGenerator {
  let i = 0;
  return { next: () => ids[i++] ?? `id-${i}` };
}

class FakeRepo implements JournalEntryRepository {
  store = new Map<string, JournalEntry>();
  saved: JournalEntry[] = [];
  save(e: JournalEntry): Promise<void> {
    this.store.set(e.id, e);
    this.saved.push(e);
    return Promise.resolve();
  }
  findById(id: string): Promise<JournalEntry | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }
  existsReversalOf(id: string): Promise<boolean> {
    return Promise.resolve([...this.store.values()].some((e) => e.props.reversalOf === id));
  }
}

function originalEntry(ids: IdGenerator): JournalEntry {
  return JournalEntry.create(
    {
      companyId: 'co-1',
      financialYearId: 'fy-1',
      entryNo: 'IPC/2526/0001',
      voucherType: 'SALES_IPC',
      voucherDate: '2025-07-15',
      sourceType: 'IPC',
      sourceId: 's-1',
      postedBy: 'poster',
      lines: [
        { accountId: 'ar', projectId: 'p1', debit: Money.of('100.0000'), credit: Money.zero() },
        { accountId: 'rev', projectId: 'p1', debit: Money.zero(), credit: Money.of('100.0000') },
      ],
    },
    ids,
    clock,
  );
}

function build(opts: { period?: PeriodService; project?: ProjectStatusService } = {}) {
  const calls: string[] = [];
  const repo = new FakeRepo();
  const numbering: NumberingService = {
    next: () => {
      calls.push('numbering');
      return Promise.resolve('IPC/2526/0002');
    },
  };
  const period: PeriodService = opts.period ?? { assertOpen: () => Promise.resolve() };
  const project: ProjectStatusService = opts.project ?? { assertNotClosed: () => Promise.resolve() };
  const masters: MasterLookupService = { assertReferencesValid: () => Promise.resolve() };
  const service = new PostingService(
    repo,
    numbering,
    period,
    new OverviewTagMatrix(),
    project,
    masters,
    seqIds('reversal-1'),
    clock,
  );
  return { service, repo, calls };
}

describe('PostingService.reverse', () => {
  it('AC1: writes a swapped, linked reversal; original untouched', async () => {
    const { service, repo } = build();
    const original = originalEntry(seqIds('orig-1'));
    await repo.save(original);

    const reversal = await service.reverse('orig-1', 'co-1', 'wrong amount', 'reverser');
    expect(reversal.props.isReversal).toBe(true);
    expect(reversal.props.reversalOf).toBe('orig-1');
    expect(reversal.props.entryNo).toBe('IPC/2526/0002');
    expect(reversal.props.postedBy).toBe('reverser');
    expect(reversal.props.lines[0].credit.equals(Money.of('100.0000'))).toBe(true); // was debit
    // original intact
    expect(original.props.isReversal).toBe(false);
    expect(original.props.lines[0].debit.equals(Money.of('100.0000'))).toBe(true);
  });

  it('AC2: reversing an already-reversed entry throws AlreadyReversedError', async () => {
    const { service, repo } = build();
    await repo.save(originalEntry(seqIds('orig-1')));
    await service.reverse('orig-1', 'co-1', 'first', 'reverser'); // creates reversal-1 → reversal_of=orig-1
    await expect(service.reverse('orig-1', 'co-1', 'again', 'reverser')).rejects.toBeInstanceOf(
      AlreadyReversedError,
    );
  });

  it('AC2: reversing a reversal entry throws CannotReverseReversalError', async () => {
    const { service, repo } = build();
    await repo.save(originalEntry(seqIds('orig-1')));
    const reversal = await service.reverse('orig-1', 'co-1', 'first', 'reverser');
    await expect(service.reverse(reversal.id, 'co-1', 'x', 'reverser')).rejects.toBeInstanceOf(
      CannotReverseReversalError,
    );
  });

  it('AC3: closed period → rejected, numbering never called', async () => {
    const { service, repo, calls } = build({
      period: { assertOpen: () => Promise.reject(new PeriodClosedError('p', '2025-07-15')) },
    });
    await repo.save(originalEntry(seqIds('orig-1')));
    await expect(service.reverse('orig-1', 'co-1', 'x', 'reverser')).rejects.toBeInstanceOf(
      PeriodClosedError,
    );
    expect(calls).not.toContain('numbering');
  });

  it('AC3: closed project → rejected, numbering never called', async () => {
    const { service, repo, calls } = build({
      project: { assertNotClosed: () => Promise.reject(new ProjectClosedError('p1')) },
    });
    await repo.save(originalEntry(seqIds('orig-1')));
    await expect(service.reverse('orig-1', 'co-1', 'x', 'reverser')).rejects.toBeInstanceOf(
      ProjectClosedError,
    );
    expect(calls).not.toContain('numbering');
  });
});
