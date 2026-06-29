/**
 * PostingService use-case tests with fake ports (no DB) — orchestration ORDER, numbering called
 * exactly once and LAST, and every validation failure path leaving numbering uncalled and nothing
 * written (FR-LED-002/018/019/020, AC7/AC8/AC10/AC11). 100% on PostingService.
 */
import { PostingService } from '../../../src/core/posting/application/posting.service';
import { JournalEntry } from '../../../src/core/posting/domain/journal-entry';
import { JournalEntryRepository } from '../../../src/core/posting/domain/ports/journal-entry.repository';
import { NumberingService } from '../../../src/core/posting/domain/ports/numbering.service';
import { PeriodService } from '../../../src/core/posting/domain/ports/period.service';
import { ProjectStatusService } from '../../../src/core/posting/domain/ports/project-status.service';
import { MasterLookupService } from '../../../src/core/posting/domain/ports/master-lookup.service';
import { OverviewTagMatrix } from '../../../src/core/posting/domain/tag-matrix';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { ProjectClosedError } from '../../../src/core/posting/domain/errors';
import { PeriodClosedError } from '../../../src/core/period/domain/errors';
import { CrossCompanyReferenceError } from '../../../src/common/errors/domain-error';
import { Money } from '../../../src/common/money';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Clock } from '../../../src/common/ports/clock.port';

const ids: IdGenerator = { next: () => 'entry-1' };
const clock: Clock = { now: () => new Date('2026-07-15T10:00:00Z') };

function validCmd(): PostingCommand {
  const dims = { projectId: 'p', costCentreId: 'c', purposeId: 'pu' };
  return {
    companyId: 'co-1',
    financialYearId: 'fy-1',
    voucherType: 'SALES_IPC',
    voucherDate: '2025-07-15',
    sourceType: 'IPC',
    sourceId: 'ipc-1',
    postedBy: 'u-1',
    lines: [
      { accountId: 'ar', ...dims, isControlAccount: true, partyId: 'cust', debit: Money.of('1000.0000'), credit: Money.zero() },
      { accountId: 'rev', ...dims, debit: Money.zero(), credit: Money.of('1000.0000') },
    ],
  };
}

function build(overrides: {
  period?: PeriodService;
  project?: ProjectStatusService;
  masters?: MasterLookupService;
} = {}) {
  const calls: string[] = [];
  const saved: JournalEntry[] = [];
  const numberingCalls: string[] = [];

  const entries: JournalEntryRepository = {
    save: (e) => {
      calls.push('save');
      saved.push(e);
      return Promise.resolve();
    },
    findById: () => Promise.resolve(null),
    existsReversalOf: () => Promise.resolve(false),
  };
  const numbering: NumberingService = {
    next: (type) => {
      calls.push('numbering');
      numberingCalls.push(type);
      return Promise.resolve('IPC/2526/0001');
    },
  };
  const period: PeriodService = overrides.period ?? {
    assertOpen: () => {
      calls.push('period');
      return Promise.resolve();
    },
  };
  const project: ProjectStatusService = overrides.project ?? {
    assertNotClosed: () => {
      calls.push('project');
      return Promise.resolve();
    },
  };
  const masters: MasterLookupService = overrides.masters ?? {
    assertReferencesValid: () => {
      calls.push('refs');
      return Promise.resolve();
    },
  };
  const tags = new OverviewTagMatrix();
  const origAssert = tags.assert.bind(tags);
  tags.assert = (cmd) => {
    calls.push('tags');
    origAssert(cmd);
  };

  const service = new PostingService(entries, numbering, period, tags, project, masters, ids, clock);
  return { service, calls, saved, numberingCalls };
}

describe('PostingService', () => {
  it('runs checks in order period→project→tags→refs→numbering→save; numbering once + last (AC8)', async () => {
    const { service, calls, saved, numberingCalls } = build();
    const entry = await service.post(validCmd());
    expect(calls).toEqual(['period', 'project', 'tags', 'refs', 'numbering', 'save']);
    expect(numberingCalls).toEqual(['SALES_IPC']);
    expect(entry.props.entryNo).toBe('IPC/2526/0001');
    expect(saved).toHaveLength(1);
  });

  it('closed period → rejected, numbering NEVER called, nothing saved (AC10)', async () => {
    const { service, calls, saved } = build({
      period: {
        assertOpen: () => Promise.reject(new PeriodClosedError('p-1', '2025-07-15')),
      },
    });
    await expect(service.post(validCmd())).rejects.toBeInstanceOf(PeriodClosedError);
    expect(calls).not.toContain('numbering');
    expect(saved).toHaveLength(0);
  });

  it('closed project → rejected before numbering (AC10)', async () => {
    const { service, calls } = build({
      project: { assertNotClosed: () => Promise.reject(new ProjectClosedError('p')) },
    });
    await expect(service.post(validCmd())).rejects.toBeInstanceOf(ProjectClosedError);
    expect(calls).not.toContain('numbering');
  });

  it('cross-company reference → rejected before numbering (AC11)', async () => {
    const { service, calls } = build({
      masters: { assertReferencesValid: () => Promise.reject(new CrossCompanyReferenceError('bad ref')) },
    });
    await expect(service.post(validCmd())).rejects.toBeInstanceOf(CrossCompanyReferenceError);
    expect(calls).not.toContain('numbering');
  });

  it('missing required dimension → TagMatrixError before numbering (AC9)', async () => {
    const { service, calls } = build();
    const cmd = validCmd();
    cmd.voucherType = 'PURCHASE'; // now godown is required but absent
    await expect(service.post(cmd)).rejects.toThrow(/godown_id is required/);
    expect(calls).not.toContain('numbering');
  });

  it('imbalanced command → rejected before numbering (AC8)', async () => {
    const { service, calls } = build();
    const cmd = validCmd();
    cmd.lines[1].credit = Money.of('900.0000'); // 1000 dr vs 900 cr
    await expect(service.post(cmd)).rejects.toThrow();
    expect(calls).not.toContain('numbering');
  });
});
