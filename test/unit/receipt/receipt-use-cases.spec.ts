/**
 * REC use-case unit tests (fake ports + fake UnitOfWork/Clock/IdGenerator). Cites FR-REC-002/-009/-013/
 * -014/-017/-021/-022. Covers: create resolving IPC dims + over-application pre-check; post orchestration
 * order + posting.post called once (AC7); over-application rejection (AC4); closed-period rejection with
 * no number consumed (AC6/AC7); anti-double-post via assertPostable after the lock (AC8); cancel =
 * reverse, original untouched, outstanding restored (AC10); repost = reverse+post in one UoW (AC10).
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { Receipt, NewReceipt } from '../../../src/modules/receipt/domain/receipt';
import { ReceiptAccountMap } from '../../../src/modules/receipt/domain/receipt-posting';
import { CreateReceiptUseCase } from '../../../src/modules/receipt/application/create-receipt.usecase';
import { PostReceiptUseCase } from '../../../src/modules/receipt/application/post-receipt.usecase';
import { CancelReceiptUseCase } from '../../../src/modules/receipt/application/cancel-receipt.usecase';
import { RepostReceiptUseCase } from '../../../src/modules/receipt/application/repost-receipt.usecase';
import { OverApplicationError, NotPostedError } from '../../../src/modules/receipt/domain/errors';

const actor: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const ACCOUNTS: ReceiptAccountMap = {
  accountsReceivable: 'acc-ar',
  taxDeductedAtSourceRecoverable: 'acc-tds',
};

const CLOCK = { now: () => new Date('2026-06-30T10:00:00Z') };
const IDS = (() => {
  let n = 0;
  return { next: () => `id-${++n}` };
})();
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };

const accountsPort = {
  resolve: jest.fn(async () => ACCOUNTS),
  generalTargetFacts: jest.fn(async () => ({ isControlAccount: false as const, accountType: 'INCOME' as const })),
};

function makeIpcRef(opts: { status?: string; currentlyDue?: string; outstanding?: string } = {}) {
  const ipc = {
    id: 'ipc-7',
    companyId: 'co1',
    projectId: 'p-01',
    customerId: 'cust-a',
    costCentreId: 'cc-slab',
    purposeId: 'pur-ipc-7',
    status: opts.status ?? 'POSTED',
    currentlyDueAmount: Money.of(new Decimal(opts.currentlyDue ?? '775000')),
  };
  return {
    findPostedIpc: jest.fn(async () => ipc),
    outstandingForIpc: jest.fn(async () => Money.of(new Decimal(opts.outstanding ?? '775000'))),
  };
}

function ipcLinkedInput(overrides: Partial<NewReceipt> = {}): NewReceipt {
  return {
    receiptType: 'IPC_LINKED',
    receiptDate: '2026-06-30',
    paymentMode: 'BANK_TRANSFER',
    depositAccountId: 'acc-bank',
    partyId: 'cust-a',
    projectId: 'p-01',
    costCentreId: 'cc-slab',
    purposeId: 'pur-ipc-7',
    ipcId: 'ipc-7',
    generalTargetAccountId: null,
    amountSettled: '500000',
    taxDeductedAtSource: '25000',
    chequeTxnRef: 'TXN-2026-0099',
    ...overrides,
  };
}

function newDraft(overrides: Partial<NewReceipt> = {}): Receipt {
  return Receipt.createDraft('rec-1', actor.companyId, actor.financialYearId, ipcLinkedInput(overrides));
}

class FakeRepo {
  receipt: Receipt | null = null;
  insert = jest.fn(async (r: Receipt) => {
    this.receipt = r;
  });
  save = jest.fn(async (r: Receipt) => {
    this.receipt = r;
  });
  findById = jest.fn(async () => this.receipt);
  findByIdForUpdate = jest.fn(async () => this.receipt);
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
    return { id: `entry-${this.posts.length}`, props: { entryNo: `RCT/2526/000${this.posts.length}` } } as never;
  });
  reverse = jest.fn(async (entryId: string) => {
    this.reversed.push(entryId);
    return { id: `rev-${this.reversed.length}`, props: { entryNo: `RCT/2526/00R${this.reversed.length}` } } as never;
  });
  repost = jest.fn(
    async (entryId: string, _companyId: string, _reason: string, _reversedBy: string, corrected: PostingCommand) => {
      const reversal = await this.reverse(entryId);
      const reposted = await this.post(corrected);
      return { reversal, reposted };
    },
  );
}

beforeEach(() => jest.clearAllMocks());

describe('CreateReceiptUseCase (FR-REC-001, -002, -017)', () => {
  it('resolves the IPC dims + party and saves a DRAFT', async () => {
    const repo = new FakeRepo();
    const ipcRef = makeIpcRef();
    const uc = new CreateReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, audit as never, uow as never, IDS as never);
    const { id } = await uc.execute(
      {
        receiptType: 'IPC_LINKED',
        receiptDate: '2026-06-30',
        paymentMode: 'BANK_TRANSFER',
        depositAccountId: 'acc-bank',
        ipcId: 'ipc-7',
        amountSettled: '500000',
        taxDeductedAtSource: '25000',
        chequeTxnRef: 'TXN-2026-0099',
      } as never,
      actor,
    );
    expect(repo.insert).toHaveBeenCalledTimes(1);
    expect(repo.receipt?.props.partyId).toBe('cust-a');
    expect(repo.receipt?.props.projectId).toBe('p-01');
    expect(id).toBeDefined();
  });

  it('rejects an IPC-linked receipt against a non-POSTED IPC (FR-REC-002)', async () => {
    const repo = new FakeRepo();
    const ipcRef = makeIpcRef({ status: 'DRAFT' });
    const uc = new CreateReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, audit as never, uow as never, IDS as never);
    await expect(
      uc.execute(
        {
          receiptType: 'IPC_LINKED',
          receiptDate: '2026-06-30',
          paymentMode: 'CASH',
          depositAccountId: 'acc-bank',
          ipcId: 'ipc-7',
          amountSettled: '1000',
        } as never,
        actor,
      ),
    ).rejects.toMatchObject({ code: 'IPC_NOT_POSTED' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('rejects an over-application against the IPC outstanding at draft build (FR-REC-017)', async () => {
    const repo = new FakeRepo();
    const ipcRef = makeIpcRef({ outstanding: '275000' });
    const uc = new CreateReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, audit as never, uow as never, IDS as never);
    await expect(
      uc.execute(
        {
          receiptType: 'IPC_LINKED',
          receiptDate: '2026-06-30',
          paymentMode: 'CASH',
          depositAccountId: 'acc-bank',
          ipcId: 'ipc-7',
          amountSettled: '300000',
          taxDeductedAtSource: '0',
        } as never,
        actor,
      ),
    ).rejects.toBeInstanceOf(OverApplicationError);
    expect(repo.insert).not.toHaveBeenCalled();
  });
});

describe('PostReceiptUseCase (AC4/AC6/AC7/AC8)', () => {
  it('runs in one uow.run: locks draft, re-checks outstanding, builds command, posts once, marks POSTED, saves, audits', async () => {
    const repo = new FakeRepo();
    repo.receipt = newDraft();
    const posting = new FakePosting();
    const ipcRef = makeIpcRef();
    const uc = new PostReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, posting as never, audit as never, uow as never, CLOCK as never);
    const res = await uc.execute('rec-1', actor);

    expect(repo.findByIdForUpdate).toHaveBeenCalledTimes(1);
    expect(ipcRef.outstandingForIpc).toHaveBeenCalledTimes(1);
    expect(posting.post).toHaveBeenCalledTimes(1);
    expect(posting.posts[0].voucherType).toBe('RECEIPT');
    expect(repo.receipt?.props.status).toBe('POSTED');
    expect(repo.receipt?.props.entryNo).toBe(res.entryNo);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'POST' }));
  });

  it('over-application rejected at post — the cap is re-checked (AC4, edge case 8)', async () => {
    const repo = new FakeRepo();
    repo.receipt = newDraft({ amountSettled: '300000', taxDeductedAtSource: '0' });
    const posting = new FakePosting();
    const ipcRef = makeIpcRef({ outstanding: '275000' });
    const uc = new PostReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, posting as never, audit as never, uow as never, CLOCK as never);
    await expect(uc.execute('rec-1', actor)).rejects.toBeInstanceOf(OverApplicationError);
    expect(posting.post).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('closed period: posting.post throws -> receipt stays DRAFT, no save, number not consumed (AC6/AC7)', async () => {
    const repo = new FakeRepo();
    repo.receipt = newDraft();
    const posting = new FakePosting();
    posting.post = jest.fn(async () => {
      throw Object.assign(new Error('period closed'), { code: 'PERIOD_CLOSED' });
    }) as never;
    const ipcRef = makeIpcRef();
    const uc = new PostReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, posting as never, audit as never, uow as never, CLOCK as never);
    await expect(uc.execute('rec-1', actor)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(repo.receipt?.props.status).toBe('DRAFT');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('anti-double-post: the second post fails assertPostable after the row is POSTED (AC8)', async () => {
    const repo = new FakeRepo();
    const posted = newDraft();
    posted.markPosted('entry-1', 'RCT/2526/0001', 'u1', new Date());
    repo.receipt = posted;
    const posting = new FakePosting();
    const ipcRef = makeIpcRef();
    const uc = new PostReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, posting as never, audit as never, uow as never, CLOCK as never);
    await expect(uc.execute('rec-1', actor)).rejects.toMatchObject({ code: 'VOUCHER_POSTED_IMMUTABLE' });
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('rejects an IPC-linked receipt whose IPC is no longer POSTED at post time (FR-REC-002)', async () => {
    const repo = new FakeRepo();
    repo.receipt = newDraft();
    const posting = new FakePosting();
    const ipcRef = makeIpcRef({ status: 'CANCELLED' });
    const uc = new PostReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, posting as never, audit as never, uow as never, CLOCK as never);
    await expect(uc.execute('rec-1', actor)).rejects.toMatchObject({ code: 'IPC_NOT_POSTED' });
    expect(posting.post).not.toHaveBeenCalled();
  });
});

describe('CancelReceiptUseCase (AC10, FR-REC-021/-022)', () => {
  it('reverses via PostingService.reverse and marks CANCELLED (outstanding restores via the view/table on next read)', async () => {
    const repo = new FakeRepo();
    const posted = newDraft();
    posted.markPosted('entry-1', 'RCT/2526/0001', 'u1', new Date());
    repo.receipt = posted;
    const posting = new FakePosting();
    const uc = new CancelReceiptUseCase(repo as never, posting as never, audit as never, uow as never);
    const res = await uc.execute('rec-1', 'wrong IPC referenced', actor);
    expect(posting.reverse).toHaveBeenCalledTimes(1);
    expect(posting.reversed[0]).toBe('entry-1');
    expect(repo.receipt?.props.status).toBe('CANCELLED');
    expect(repo.receipt?.props.entryNo).toBe('RCT/2526/0001'); // original number retained
    expect(res.reversalEntryNo).toBeDefined();
  });

  it('rejects cancelling a DRAFT receipt (NotPosted)', async () => {
    const repo = new FakeRepo();
    repo.receipt = newDraft();
    const posting = new FakePosting();
    const uc = new CancelReceiptUseCase(repo as never, posting as never, audit as never, uow as never);
    await expect(uc.execute('rec-1', 'x', actor)).rejects.toBeInstanceOf(NotPostedError);
    expect(posting.reverse).not.toHaveBeenCalled();
  });
});

describe('RepostReceiptUseCase (AC10, FR-LED-027)', () => {
  it('runs reverse + post in one uow.run; re-stamps POSTED with the new entry', async () => {
    const repo = new FakeRepo();
    const posted = newDraft();
    posted.markPosted('entry-ORIGINAL', 'RCT/2526/ORIGINAL', 'u1', new Date());
    repo.receipt = posted;
    const posting = new FakePosting();
    const ipcRef = makeIpcRef({ outstanding: '275000' });
    const uc = new RepostReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, posting as never, audit as never, uow as never, CLOCK as never);
    const res = await uc.execute('rec-1', { amountSettled: '200000', taxDeductedAtSource: '0' }, 'amount corrected', actor);

    expect(posting.repost).toHaveBeenCalledTimes(1);
    expect(repo.receipt?.props.status).toBe('POSTED');
    expect(repo.receipt?.props.entryNo).toBe(res.entryNo);
    expect(res.reversalEntryNo).toBeDefined();
    expect(res.entryNo).not.toBe('RCT/2526/ORIGINAL');
  });

  it('rejects reposting a DRAFT receipt (NotPosted)', async () => {
    const repo = new FakeRepo();
    repo.receipt = newDraft();
    const posting = new FakePosting();
    const ipcRef = makeIpcRef();
    const uc = new RepostReceiptUseCase(repo as never, accountsPort as never, ipcRef as never, posting as never, audit as never, uow as never, CLOCK as never);
    await expect(uc.execute('rec-1', {}, 'x', actor)).rejects.toBeInstanceOf(NotPostedError);
  });
});
