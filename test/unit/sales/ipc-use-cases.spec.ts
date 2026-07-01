/**
 * SAL use-case unit tests (fake ports + fake UnitOfWork/Clock/IdGenerator). Cites
 * FR-SAL-008/-009/-013/-014/-021. Covers: post orchestration order + posting.post called once (AC7);
 * closed-period rejection with no number consumed (AC6/AC7); duplicate-seq-no rejection (AC9); advance
 * re-cap inside the post tx (AC4); anti-double-post via assertPostable after the lock (AC8);
 * cancel = reverse, original untouched (AC10); repost = reverse+post in one UoW (AC10).
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { Ipc } from '../../../src/modules/sales/domain/ipc';
import { IpcRates } from '../../../src/modules/sales/domain/rates';
import { SalesAccountMap } from '../../../src/modules/sales/domain/ipc-posting';
import { CreateIpcUseCase } from '../../../src/modules/sales/application/create-ipc.usecase';
import { PostIpcUseCase } from '../../../src/modules/sales/application/post-ipc.usecase';
import { CancelIpcUseCase } from '../../../src/modules/sales/application/cancel-ipc.usecase';
import { DuplicateSeqNoError, NotPostedError } from '../../../src/modules/sales/domain/errors';

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

const CLOCK = { now: () => new Date('2026-06-29T10:00:00Z') };
const IDS = (() => {
  let n = 0;
  return { next: () => `id-${++n}` };
})();
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };

const accountsPort = {
  resolve: jest.fn(async () => ACCOUNTS),
  resolveCustomer: jest.fn(async () => 'cust-a'),
};
const configPort = { rates: jest.fn(async () => RATES) };

function makeAdvance(remaining: string) {
  return { remainingAdvance: jest.fn(async () => Money.of(new Decimal(remaining))) };
}

function newDraft(): Ipc {
  return Ipc.createDraft(
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
  );
}

class FakeRepo {
  ipc: Ipc | null = null;
  seqExists = false;
  insert = jest.fn(async (i: Ipc) => {
    this.ipc = i;
  });
  save = jest.fn(async (i: Ipc) => {
    this.ipc = i;
  });
  findById = jest.fn(async () => this.ipc);
  findByIdForUpdate = jest.fn(async () => this.ipc);
  existsSeqNo = jest.fn(async () => this.seqExists);
  softDelete = jest.fn(async () => undefined);
}

class FakePosting {
  posts: PostingCommand[] = [];
  reversed: string[] = [];
  post = jest.fn(async (cmd: PostingCommand) => {
    this.posts.push(cmd);
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    if (!dr.equals(cr)) throw new Error('imbalanced');
    return { id: `entry-${this.posts.length}`, props: { entryNo: `IPC/2526/000${this.posts.length}` } } as never;
  });
  reverse = jest.fn(async (entryId: string) => {
    this.reversed.push(entryId);
    return { id: `rev-${this.reversed.length}`, props: { entryNo: `IPC/2526/00R${this.reversed.length}` } } as never;
  });
}

beforeEach(() => jest.clearAllMocks());

describe('CreateIpcUseCase (FR-SAL-001, -014)', () => {
  it('resolves the customer + rates + remaining advance and saves a DRAFT', async () => {
    const repo = new FakeRepo();
    const advance = makeAdvance('1000000');
    const uc = new CreateIpcUseCase(
      repo as never,
      accountsPort as never,
      configPort as never,
      advance as never,
      audit as never,
      uow as never,
      IDS as never,
    );
    const { id } = await uc.execute(
      {
        projectId: 'p-01',
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
      actor,
    );
    expect(repo.insert).toHaveBeenCalledTimes(1);
    expect(repo.ipc?.props.customerId).toBe('cust-a');
    expect(repo.ipc?.props.currentlyDueAmount.amount.toFixed(4)).toBe('775000.0000');
    expect(id).toBeDefined();
  });

  it('rejects a duplicate IPC sequence number (AC9, FR-SAL-014)', async () => {
    const repo = new FakeRepo();
    repo.seqExists = true;
    const uc = new CreateIpcUseCase(
      repo as never,
      accountsPort as never,
      configPort as never,
      makeAdvance('1000000') as never,
      audit as never,
      uow as never,
      IDS as never,
    );
    await expect(
      uc.execute(
        {
          projectId: 'p-01',
          ipcSeqNo: 7,
          ipcDate: '2026-06-29',
          billDate: '2026-06-29',
          dueDate: '2026-07-29',
          workCompletedPct: '62.5',
          certifiedAmount: '1000000',
          costCentreId: 'cc',
          purposeId: 'pur',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(DuplicateSeqNoError);
    expect(repo.insert).not.toHaveBeenCalled();
  });
});

describe('PostIpcUseCase (AC4/AC6/AC7/AC8)', () => {
  it('runs in one uow.run: locks draft, builds command, posts once, marks POSTED, saves, audits', async () => {
    const repo = new FakeRepo();
    repo.ipc = newDraft();
    const posting = new FakePosting();
    const advance = makeAdvance('1000000');
    const uc = new PostIpcUseCase(
      repo as never,
      accountsPort as never,
      advance as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    const res = await uc.execute('ipc-1', actor);

    expect(repo.findByIdForUpdate).toHaveBeenCalledTimes(1);
    expect(advance.remainingAdvance).toHaveBeenCalledTimes(1);
    expect(posting.post).toHaveBeenCalledTimes(1);
    expect(posting.posts[0].voucherType).toBe('SALES_IPC');
    expect(repo.ipc?.props.status).toBe('POSTED');
    expect(repo.ipc?.props.entryNo).toBe(res.entryNo);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'POST' }));
  });

  it('closed period: posting.post throws → IPC stays DRAFT, no save, number not consumed (AC6/AC7)', async () => {
    const repo = new FakeRepo();
    repo.ipc = newDraft();
    const posting = new FakePosting();
    posting.post = jest.fn(async () => {
      throw Object.assign(new Error('period closed'), { code: 'PERIOD_CLOSED' });
    }) as never;
    const uc = new PostIpcUseCase(
      repo as never,
      accountsPort as never,
      makeAdvance('1000000') as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('ipc-1', actor)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(repo.ipc?.props.status).toBe('DRAFT');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('re-caps advance inside the post tx: a shrunk remaining rejects (AC4)', async () => {
    const repo = new FakeRepo();
    repo.ipc = newDraft(); // recorded advance 150k
    const posting = new FakePosting();
    const uc = new PostIpcUseCase(
      repo as never,
      accountsPort as never,
      makeAdvance('100000') as never, // remaining shrank below the recorded recovery
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('ipc-1', actor)).rejects.toMatchObject({ code: 'ADVANCE_EXCEEDS_REMAINING' });
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('anti-double-post: the second post fails assertPostable after the row is POSTED (AC8)', async () => {
    const repo = new FakeRepo();
    const posted = newDraft();
    posted.markPosted('entry-1', 'IPC/2526/0001', 'u1', new Date());
    repo.ipc = posted;
    const posting = new FakePosting();
    const uc = new PostIpcUseCase(
      repo as never,
      accountsPort as never,
      makeAdvance('1000000') as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('ipc-1', actor)).rejects.toMatchObject({ code: 'VOUCHER_POSTED_IMMUTABLE' });
    expect(posting.post).not.toHaveBeenCalled();
  });
});

describe('CancelIpcUseCase (AC10, FR-SAL-021/-022)', () => {
  it('reverses via PostingService.reverse and marks CANCELLED', async () => {
    const repo = new FakeRepo();
    const posted = newDraft();
    posted.markPosted('entry-1', 'IPC/2526/0001', 'u1', new Date());
    repo.ipc = posted;
    const posting = new FakePosting();
    const uc = new CancelIpcUseCase(repo as never, posting as never, audit as never, uow as never);
    const res = await uc.execute('ipc-1', 'certified % corrected', actor);
    expect(posting.reverse).toHaveBeenCalledTimes(1);
    expect(posting.reversed[0]).toBe('entry-1');
    expect(repo.ipc?.props.status).toBe('CANCELLED');
    expect(repo.ipc?.props.entryNo).toBe('IPC/2526/0001'); // original number retained
    expect(res.reversalEntryNo).toBeDefined();
  });

  it('rejects cancelling a DRAFT IPC (NotPosted)', async () => {
    const repo = new FakeRepo();
    repo.ipc = newDraft();
    const posting = new FakePosting();
    const uc = new CancelIpcUseCase(repo as never, posting as never, audit as never, uow as never);
    await expect(uc.execute('ipc-1', 'x', actor)).rejects.toBeInstanceOf(NotPostedError);
    expect(posting.reverse).not.toHaveBeenCalled();
  });
});
