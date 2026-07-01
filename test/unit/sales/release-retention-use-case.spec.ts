/**
 * ReleaseRetentionUseCase unit tests (fake ports + fake UnitOfWork/Clock/IdGenerator). Cites
 * FR-SAL-018/-019/-020. Covers: orchestration calls posting.post exactly once with the §4.2 command (AC1);
 * held recomputed from Σ POSTED releases (AC2/AC4); over-release rejected before any write, no number
 * consumed (AC2); closed-period/closed-project rejection surfaces the LED error with no save (AC3); a
 * non-POSTED IPC is rejected (VOUCHER_NOT_POSTED).
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { Ipc } from '../../../src/modules/sales/domain/ipc';
import { IpcRates } from '../../../src/modules/sales/domain/rates';
import { SalesAccountMap } from '../../../src/modules/sales/domain/ipc-posting';
import { ReleaseRetentionUseCase } from '../../../src/modules/sales/application/release-retention.usecase';
import { NotPostedError, OverReleaseError } from '../../../src/modules/sales/domain/errors';

const actor: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const RATES = IpcRates.of({ retentionPct: '10', advancePct: '15', vatPct: '7.5' });
const ACCOUNTS: SalesAccountMap = {
  accountsReceivable: 'acc-ar',
  retentionReceivable: 'acc-ret',
  mobilizationAdvance: 'acc-adv',
  aitRecoverable: 'acc-ait',
  revenueConstruction: 'acc-rev',
  outputVatPayable: 'acc-vat',
};

const CLOCK = { now: () => new Date('2027-06-29T10:00:00Z') };
const IDS = (() => {
  let n = 0;
  return { next: () => `rr-${++n}` };
})();
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };
const accountsPort = { resolve: jest.fn(async () => ACCOUNTS), resolveCustomer: jest.fn(async () => 'cust-a') };

function postedIpc(): Ipc {
  const ipc = Ipc.createDraft(
    'ipc-1',
    actor.companyId,
    actor.financialYearId,
    {
      projectId: 'p-01',
      customerId: 'cust-a',
      ipcSeqNo: 7,
      ipcDate: '2026-06-29',
      billDate: '2026-06-29',
      dueDate: '2026-07-29',
      workCompletedPct: '62.5',
      certifiedAmount: '1000000',
      costCentreId: 'cc',
      purposeId: 'pur',
      aitTdsAmount: '50000',
    },
    RATES,
    Money.of(new Decimal('1000000')),
  ); // retentionAmount = 100,000
  ipc.markPosted('entry-1', 'IPC/2526/0001', 'u1', new Date());
  return ipc;
}

class FakeIpcRepo {
  ipc: Ipc | null = null;
  findById = jest.fn(async () => this.ipc);
  findByIdForUpdate = jest.fn(async () => this.ipc);
}

class FakeReleaseRepo {
  inserted: unknown[] = [];
  alreadyReleased = Money.zero();
  insert = jest.fn(async (r: unknown) => {
    this.inserted.push(r);
  });
  save = jest.fn(async () => undefined);
  findById = jest.fn(async () => null);
  findByIdForUpdate = jest.fn(async () => null);
  listByIpc = jest.fn(async () => []);
  sumPostedReleasedForIpc = jest.fn(async () => this.alreadyReleased);
}

class FakePosting {
  posts: PostingCommand[] = [];
  post = jest.fn(async (cmd: PostingCommand) => {
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    if (!dr.equals(cr)) throw new Error('imbalanced');
    this.posts.push(cmd);
    return { id: `entry-${this.posts.length}`, props: { entryNo: `JV/2526/000${this.posts.length}` } } as never;
  });
}

beforeEach(() => jest.clearAllMocks());

function makeUseCase(ipcRepo: FakeIpcRepo, releaseRepo: FakeReleaseRepo, posting: FakePosting) {
  return new ReleaseRetentionUseCase(
    ipcRepo as never,
    releaseRepo as never,
    accountsPort as never,
    posting as never,
    audit as never,
    uow as never,
    CLOCK as never,
    IDS as never,
  );
}

describe('ReleaseRetentionUseCase — orchestration (AC1, FR-SAL-018)', () => {
  it('posts the §4.2 command exactly once, marks POSTED, inserts, audits', async () => {
    const ipcRepo = new FakeIpcRepo();
    ipcRepo.ipc = postedIpc();
    const releaseRepo = new FakeReleaseRepo();
    const posting = new FakePosting();
    const uc = makeUseCase(ipcRepo, releaseRepo, posting);

    const res = await uc.execute('ipc-1', { releaseDate: '2027-06-29', releasedAmount: '100000' }, actor);

    expect(posting.post).toHaveBeenCalledTimes(1);
    expect(posting.posts[0].voucherType).toBe('JOURNAL');
    expect(posting.posts[0].lines).toHaveLength(2);
    expect(releaseRepo.insert).toHaveBeenCalledTimes(1);
    expect(res.entryNo).toBe('JV/2526/0001');
    expect(res.releasedAmount).toBe('100000.0000');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'POST', entityType: 'RetentionRelease' }));
  });

  it('omitting releasedAmount releases the full held amount', async () => {
    const ipcRepo = new FakeIpcRepo();
    ipcRepo.ipc = postedIpc(); // retention 100,000
    const releaseRepo = new FakeReleaseRepo();
    const posting = new FakePosting();
    const uc = makeUseCase(ipcRepo, releaseRepo, posting);

    const res = await uc.execute('ipc-1', { releaseDate: '2027-06-29' }, actor);
    expect(res.releasedAmount).toBe('100000.0000');
  });
});

describe('ReleaseRetentionUseCase — held recomputed from releases (AC2/AC4, FR-SAL-019)', () => {
  it('held = retentionAmount - Σ posted releases; a second release is capped at the remainder', async () => {
    const ipcRepo = new FakeIpcRepo();
    ipcRepo.ipc = postedIpc(); // retention 100,000
    const releaseRepo = new FakeReleaseRepo();
    releaseRepo.alreadyReleased = Money.of(new Decimal('60000')); // already released 60,000
    const posting = new FakePosting();
    const uc = makeUseCase(ipcRepo, releaseRepo, posting);

    // held = 100,000 - 60,000 = 40,000; requesting 40,000 exactly should pass.
    const res = await uc.execute('ipc-1', { releaseDate: '2027-06-29', releasedAmount: '40000' }, actor);
    expect(res.releasedAmount).toBe('40000.0000');
  });

  it('an over-release beyond the remaining held is rejected before any posting.post call (AC2)', async () => {
    const ipcRepo = new FakeIpcRepo();
    ipcRepo.ipc = postedIpc(); // retention 100,000
    const releaseRepo = new FakeReleaseRepo();
    releaseRepo.alreadyReleased = Money.of(new Decimal('60000'));
    const posting = new FakePosting();
    const uc = makeUseCase(ipcRepo, releaseRepo, posting);

    await expect(
      uc.execute('ipc-1', { releaseDate: '2027-06-29', releasedAmount: '40000.01' }, actor),
    ).rejects.toBeInstanceOf(OverReleaseError);
    expect(posting.post).not.toHaveBeenCalled();
    expect(releaseRepo.insert).not.toHaveBeenCalled();
  });

  it('releasing the exact held amount drops held to 0; a further release is rejected', async () => {
    const ipcRepo = new FakeIpcRepo();
    ipcRepo.ipc = postedIpc(); // retention 100,000
    const releaseRepo = new FakeReleaseRepo();
    releaseRepo.alreadyReleased = Money.of(new Decimal('100000')); // fully released already
    const posting = new FakePosting();
    const uc = makeUseCase(ipcRepo, releaseRepo, posting);

    await expect(
      uc.execute('ipc-1', { releaseDate: '2027-06-29', releasedAmount: '1' }, actor),
    ).rejects.toBeInstanceOf(OverReleaseError);
    expect(posting.post).not.toHaveBeenCalled();
  });
});

describe('ReleaseRetentionUseCase — guards (AC3, FR-SAL-020)', () => {
  it('closed-period/closed-project: posting.post throws -> nothing saved, no number consumed', async () => {
    const ipcRepo = new FakeIpcRepo();
    ipcRepo.ipc = postedIpc();
    const releaseRepo = new FakeReleaseRepo();
    const posting = new FakePosting();
    posting.post = jest.fn(async () => {
      throw Object.assign(new Error('period closed'), { code: 'PERIOD_CLOSED' });
    }) as never;
    const uc = makeUseCase(ipcRepo, releaseRepo, posting);

    await expect(
      uc.execute('ipc-1', { releaseDate: '2027-06-29', releasedAmount: '50000' }, actor),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(releaseRepo.insert).not.toHaveBeenCalled();
  });

  it('rejects releasing against a non-POSTED IPC (VOUCHER_NOT_POSTED)', async () => {
    const ipcRepo = new FakeIpcRepo();
    ipcRepo.ipc = Ipc.createDraft(
      'ipc-1',
      actor.companyId,
      actor.financialYearId,
      {
        projectId: 'p-01',
        customerId: 'cust-a',
        ipcSeqNo: 7,
        ipcDate: '2026-06-29',
        billDate: '2026-06-29',
        dueDate: '2026-07-29',
        workCompletedPct: '62.5',
        certifiedAmount: '1000000',
        costCentreId: 'cc',
        purposeId: 'pur',
      },
      RATES,
      Money.of(new Decimal('1000000')),
    ); // still DRAFT
    const releaseRepo = new FakeReleaseRepo();
    const posting = new FakePosting();
    const uc = makeUseCase(ipcRepo, releaseRepo, posting);

    await expect(
      uc.execute('ipc-1', { releaseDate: '2027-06-29', releasedAmount: '1000' }, actor),
    ).rejects.toBeInstanceOf(NotPostedError);
    expect(posting.post).not.toHaveBeenCalled();
  });
});
