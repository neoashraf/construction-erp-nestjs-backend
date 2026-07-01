/**
 * INV Stock Journal use-case unit tests (fake PostingService/repos/UoW, mirrors
 * `test/unit/contra-journal/contra-journal-use-cases.spec.ts`'s FakePosting/fake-repo/fake-UoW pattern).
 * Cites FR-INV-010/-012/-014/-016/-017/-018. Covers: issue posts Dr-expense/Cr-inventory exactly once +
 * balanced; same-account transfer writes movements but does NOT call posting.post and leaves
 * entryNo/journalEntryId null; cross-account transfer (fake resolver, two distinct accounts) posts
 * Dr-to/Cr-from balanced; post before approve throws NotApprovedError; negative stock blocked/authorised;
 * atomic rollback on a forced posting.post failure leaves the voucher APPROVED with no save.
 */
import Decimal from 'decimal.js';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { StockJournal, NewStockJournal } from '../../../src/modules/inventory/domain/stock-journal';
import { NegativeStockError } from '../../../src/modules/inventory/domain/errors';
import { CreateStockJournalUseCase } from '../../../src/modules/inventory/application/create-stock-journal.usecase';
import { ApproveStockJournalUseCase } from '../../../src/modules/inventory/application/approve-stock-journal.usecase';
import { PostStockJournalUseCase } from '../../../src/modules/inventory/application/post-stock-journal.usecase';
import { ReverseStockJournalUseCase } from '../../../src/modules/inventory/application/reverse-stock-journal.usecase';
import { AccessPolicy } from '../../../src/core/auth/domain/access-policy';

const actor: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'StoreKeeper',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const CLOCK = { now: () => new Date('2026-07-01T00:00:00Z') };
function makeIds() {
  let n = 0;
  return { next: () => `id-${++n}` };
}
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };
const tagConsistency = { assertConsistent: jest.fn(async () => undefined) };

class FakePosting {
  posts: PostingCommand[] = [];
  reversed: Array<{ entryId: string; companyId: string; reason: string; by: string }> = [];
  post = jest.fn(async (cmd: PostingCommand) => {
    this.posts.push(cmd);
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    if (!dr.equals(cr)) throw new Error('imbalanced');
    return { id: `entry-${this.posts.length}`, props: { entryNo: `SJ-${this.posts.length}` } } as never;
  });
  reverse = jest.fn(async (entryId: string, companyId: string, reason: string, by: string) => {
    this.reversed.push({ entryId, companyId, reason, by });
    return { id: `rev-${this.reversed.length}`, props: { entryNo: `RNO-${this.reversed.length}` } } as never;
  });
}

/** A fake StockMovementRepository — a single (godown,item) balance keyed by godownId. */
function fakeMovements(initial: Record<string, { qty: string; value: string }>) {
  const balances = new Map(
    Object.entries(initial).map(([k, v]) => [k, { qty: new Decimal(v.qty), value: new Decimal(v.value) }]),
  );
  const appended: unknown[] = [];
  return {
    appended,
    append: jest.fn(async (m: { props: Record<string, unknown> }) => {
      appended.push(m.props);
    }),
    currentBalanceForUpdate: jest.fn(async (_companyId: string, godownId: string) => {
      return balances.get(godownId) ?? { qty: new Decimal(0), value: new Decimal(0) };
    }),
    balanceAsOf: jest.fn(),
  };
}

function fakeAccounts(inventoryByGodownItem: (companyId: string, itemId: string) => Promise<string> | string, expenseAccountId = 'acct-expense') {
  return {
    inventoryAccountOf: jest.fn(async (companyId: string, itemId: string) => inventoryByGodownItem(companyId, itemId)),
    expenseAccountOf: jest.fn(async () => expenseAccountId),
  };
}

function issueDraft(): StockJournal {
  const input: NewStockJournal = {
    voucherDate: '2026-06-20',
    mode: 'ISSUE',
    fromGodownId: 'g-site-a',
    toGodownId: null,
    itemId: 'item-cement',
    quantity: '50',
    projectId: 'p-01',
    costCentreId: 'cc-slab',
    purposeId: 'pur-day20',
  };
  const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', input);
  sj.approve('pm1', new Date());
  return sj;
}

function transferDraft(): StockJournal {
  const input: NewStockJournal = {
    voucherDate: '2026-06-20',
    mode: 'TRANSFER',
    fromGodownId: 'g-site-a',
    toGodownId: 'g-site-b',
    itemId: 'item-cement',
    quantity: '30',
    projectId: 'p-01',
    costCentreId: 'cc-slab',
    purposeId: 'pur-day20',
  };
  const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', input);
  sj.approve('pm1', new Date());
  return sj;
}

describe('CreateStockJournalUseCase (FR-INV-008, FR-CC-004)', () => {
  it('builds a DRAFT, runs tag-consistency on each side, inserts', async () => {
    const repo = { insert: jest.fn(async () => undefined) };
    const uc = new CreateStockJournalUseCase(repo as never, tagConsistency as never, audit as never, uow as never, makeIds());
    const { id } = await uc.execute(
      {
        voucherDate: '2026-06-20',
        mode: 'ISSUE',
        fromGodownId: 'g-site-a',
        itemId: 'item-cement',
        quantity: '50',
        projectId: 'p-01',
        costCentreId: 'cc-slab',
        purposeId: 'pur-day20',
      },
      actor,
    );
    expect(id).toBeTruthy();
    expect(repo.insert).toHaveBeenCalledTimes(1);
    expect(tagConsistency.assertConsistent).toHaveBeenCalledTimes(1);
  });
});

describe('ApproveStockJournalUseCase (FR-INV-012/-013)', () => {
  it('DRAFT → APPROVED, project-scope-checked, saved', async () => {
    const input: NewStockJournal = {
      voucherDate: '2026-06-20',
      mode: 'ISSUE',
      fromGodownId: 'g-site-a',
      itemId: 'item-cement',
      quantity: '50',
      projectId: 'p-01',
      costCentreId: 'cc-slab',
      purposeId: 'pur-day20',
    };
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', input);
    const repo = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn(async () => undefined) };
    const uc = new ApproveStockJournalUseCase(repo as never, new AccessPolicy(), audit as never, uow as never, CLOCK);
    await uc.execute('sj1', actor);
    expect(sj.props.status).toBe('APPROVED');
    expect(sj.props.approvedById).toBe('u1');
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});

describe('PostStockJournalUseCase (FR-INV-010/-014/-016/-017/-018)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ISSUE posts Dr-expense/Cr-inventory exactly once, balanced, tagged (FR-INV-016, design §4.1)', async () => {
    const sj = issueDraft();
    const journals = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn(async () => undefined) };
    const movements = fakeMovements({ 'g-site-a': { qty: '100', value: '52000' } }); // avg 520
    const posting = new FakePosting();
    const accounts = fakeAccounts(() => 'acct-inventory');
    const uc = new PostStockJournalUseCase(
      journals as never,
      movements as never,
      posting as never,
      accounts as never,
      audit as never,
      uow as never,
      CLOCK,
      makeIds(),
    );
    const res = await uc.execute('sj1', {}, actor);
    expect(posting.post).toHaveBeenCalledTimes(1);
    const cmd = posting.posts[0];
    expect(cmd.voucherType).toBe('STOCK_JOURNAL');
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.equals(cr)).toBe(true);
    expect(dr.toFixed(4)).toBe('26000.0000'); // 50 * 520
    for (const line of cmd.lines) {
      expect(line.projectId).toBe('p-01');
      expect(line.costCentreId).toBe('cc-slab');
      expect(line.purposeId).toBe('pur-day20');
      expect(line.godownId).toBe('g-site-a');
    }
    const expenseLine = cmd.lines.find((l) => l.accountId === 'acct-expense')!;
    expect(expenseLine.debit.amount.toFixed(4)).toBe('26000.0000');
    const invLine = cmd.lines.find((l) => l.accountId === 'acct-inventory')!;
    expect(invLine.credit.amount.toFixed(4)).toBe('26000.0000');
    expect(res.entryNo).toBe('SJ-1');
    expect(sj.props.status).toBe('POSTED');
    expect(movements.append).toHaveBeenCalledTimes(1);
    expect(journals.save).toHaveBeenCalledTimes(1);
  });

  it('same-account TRANSFER writes two movements but does NOT call posting.post; entryNo/journalEntryId stay null (design §4.2)', async () => {
    const sj = transferDraft();
    const journals = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn(async () => undefined) };
    const movements = fakeMovements({ 'g-site-a': { qty: '100', value: '52000' }, 'g-site-b': { qty: '0', value: '0' } });
    const posting = new FakePosting();
    const accounts = fakeAccounts(() => 'acct-inventory-shared'); // both sides resolve to the SAME account
    const uc = new PostStockJournalUseCase(
      journals as never,
      movements as never,
      posting as never,
      accounts as never,
      audit as never,
      uow as never,
      CLOCK,
      makeIds(),
    );
    const res = await uc.execute('sj1', {}, actor);
    expect(posting.post).not.toHaveBeenCalled();
    expect(movements.append).toHaveBeenCalledTimes(2);
    expect(res.entryNo).toBeNull();
    expect(res.journalEntryId).toBeNull();
    expect(sj.props.entryNo).toBeNull();
    expect(sj.props.journalEntryId).toBeNull();
    expect(sj.props.status).toBe('POSTED');
  });

  it('cross-account TRANSFER posts Dr-to/Cr-from balanced (fake resolver, two distinct accounts, design §4.3)', async () => {
    const sj = transferDraft();
    const journals = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn(async () => undefined) };
    const movements = fakeMovements({ 'g-site-a': { qty: '100', value: '52000' }, 'g-site-b': { qty: '0', value: '0' } });
    const posting = new FakePosting();
    // Fake resolver returns two DIFFERENT account ids per godown-side call order (from, then to).
    let call = 0;
    const accounts = fakeAccounts(() => {
      call += 1;
      return call === 1 ? 'acct-site-a-inventory' : 'acct-central-inventory';
    });
    const uc = new PostStockJournalUseCase(
      journals as never,
      movements as never,
      posting as never,
      accounts as never,
      audit as never,
      uow as never,
      CLOCK,
      makeIds(),
    );
    const res = await uc.execute('sj1', {}, actor);
    expect(posting.post).toHaveBeenCalledTimes(1);
    const cmd = posting.posts[0];
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.equals(cr)).toBe(true);
    expect(dr.toFixed(4)).toBe('15600.0000'); // 30 * 520
    const toLine = cmd.lines.find((l) => l.accountId === 'acct-central-inventory')!;
    expect(toLine.debit.amount.toFixed(4)).toBe('15600.0000');
    expect(toLine.godownId).toBe('g-site-b');
    const fromLine = cmd.lines.find((l) => l.accountId === 'acct-site-a-inventory')!;
    expect(fromLine.credit.amount.toFixed(4)).toBe('15600.0000');
    expect(fromLine.godownId).toBe('g-site-a');
    expect(res.entryNo).toBe('SJ-1');
  });

  it('post before approve throws NotApprovedError (edge 3)', async () => {
    const input: NewStockJournal = {
      voucherDate: '2026-06-20',
      mode: 'ISSUE',
      fromGodownId: 'g-site-a',
      itemId: 'item-cement',
      quantity: '50',
      projectId: 'p-01',
      costCentreId: 'cc-slab',
      purposeId: 'pur-day20',
    };
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', input); // still DRAFT
    const journals = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn() };
    const movements = fakeMovements({});
    const posting = new FakePosting();
    const accounts = fakeAccounts(() => 'acct-inventory');
    const uc = new PostStockJournalUseCase(
      journals as never,
      movements as never,
      posting as never,
      accounts as never,
      audit as never,
      uow as never,
      CLOCK,
      makeIds(),
    );
    await expect(uc.execute('sj1', {}, actor)).rejects.toThrow(/APPROVED/);
    expect(posting.post).not.toHaveBeenCalled();
    expect(movements.append).not.toHaveBeenCalled();
  });

  it('negative stock is blocked by default (NegativeStockError, FR-INV-014)', async () => {
    const sj = issueDraft(); // wants 50
    const journals = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn() };
    const movements = fakeMovements({ 'g-site-a': { qty: '10', value: '5200' } }); // only 10 on hand
    const posting = new FakePosting();
    const accounts = fakeAccounts(() => 'acct-inventory');
    const uc = new PostStockJournalUseCase(
      journals as never,
      movements as never,
      posting as never,
      accounts as never,
      audit as never,
      uow as never,
      CLOCK,
      makeIds(),
    );
    await expect(uc.execute('sj1', {}, actor)).rejects.toThrow(NegativeStockError);
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('negative stock proceeds when authorised, and the reason is required (FR-INV-014/-015)', async () => {
    const sj = issueDraft();
    const journals = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn(async () => undefined) };
    const movements = fakeMovements({ 'g-site-a': { qty: '10', value: '5200' } });
    const posting = new FakePosting();
    const accounts = fakeAccounts(() => 'acct-inventory');
    const uc = new PostStockJournalUseCase(
      journals as never,
      movements as never,
      posting as never,
      accounts as never,
      audit as never,
      uow as never,
      CLOCK,
      makeIds(),
    );
    // missing reason → rejected before any write
    await expect(uc.execute('sj1', { allowNegativeStock: true }, actor)).rejects.toThrow(/negativeStockReason/);
    expect(movements.append).not.toHaveBeenCalled();

    // with a reason, it proceeds
    const res = await uc.execute('sj1', { allowNegativeStock: true, negativeStockReason: 'urgent pour' }, actor);
    expect(res.entryNo).toBe('SJ-1');
    expect(sj.props.negativeStockAuthorisedById).toBe('u1');
    expect(sj.props.negativeStockReason).toBe('urgent pour');
  });

  it('atomic rollback: a forced posting.post failure leaves the voucher APPROVED with no save', async () => {
    const sj = issueDraft();
    const journals = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn(async () => undefined) };
    const movements = fakeMovements({ 'g-site-a': { qty: '100', value: '52000' } });
    const posting = new FakePosting();
    posting.post.mockRejectedValueOnce(new Error('period closed'));
    const accounts = fakeAccounts(() => 'acct-inventory');
    // uow that rolls back state changes on throw, mirroring a real transaction: since our fakes mutate
    // external maps regardless, we assert on the aggregate + repo.save call count (never reached).
    const uc = new PostStockJournalUseCase(
      journals as never,
      movements as never,
      posting as never,
      accounts as never,
      audit as never,
      uow as never,
      CLOCK,
      makeIds(),
    );
    await expect(uc.execute('sj1', {}, actor)).rejects.toThrow('period closed');
    expect(sj.props.status).toBe('APPROVED');
    expect(sj.props.entryNo).toBeNull();
    expect(journals.save).not.toHaveBeenCalled();
  });
});

describe('ReverseStockJournalUseCase (FR-INV-020)', () => {
  it('mirrors movements and calls posting.reverse only when a journalEntryId exists', async () => {
    const sj = issueDraft();
    sj.markPosted(
      'SJ-1',
      'entry-1',
      new Decimal('520'),
      new Decimal('26000'),
      sj.toLines().map((l) => l.withValuation(new Decimal('520'), new Decimal('26000'))),
      'sk1',
      new Date(),
    );
    const journals = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn(async () => undefined) };
    const movements = fakeMovements({ 'g-site-a': { qty: '50', value: '26000' } });
    const posting = new FakePosting();
    const uc = new ReverseStockJournalUseCase(
      journals as never,
      movements as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK,
      makeIds(),
    );
    await uc.execute('sj1', 'entered in error', actor);
    expect(movements.append).toHaveBeenCalledTimes(1);
    expect(posting.reverse).toHaveBeenCalledWith('entry-1', 'co1', 'entered in error', 'u1');
    expect(sj.props.status).toBe('CANCELLED');
  });

  it('a same-account transfer (no journalEntryId) mirrors movements but never calls posting.reverse', async () => {
    const sj = transferDraft();
    sj.markPosted(null, null, new Decimal('520'), new Decimal('15600'), sj.toLines().map((l) => l.withValuation(new Decimal('520'), new Decimal('15600'))), 'sk1', new Date());
    const journals = { findByIdForUpdate: jest.fn(async () => sj), save: jest.fn(async () => undefined) };
    const movements = fakeMovements({ 'g-site-a': { qty: '70', value: '36400' }, 'g-site-b': { qty: '30', value: '15600' } });
    const posting = new FakePosting();
    const uc = new ReverseStockJournalUseCase(
      journals as never,
      movements as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK,
      makeIds(),
    );
    await uc.execute('sj1', 'wrong godown', actor);
    expect(movements.append).toHaveBeenCalledTimes(2);
    expect(posting.reverse).not.toHaveBeenCalled();
    expect(sj.props.status).toBe('CANCELLED');
  });
});
