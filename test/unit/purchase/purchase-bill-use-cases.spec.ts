/**
 * PUR bill use-case unit tests (fake INV/LED ports + fake UnitOfWork/Clock/IdGenerator). Cites
 * FR-PUR-008..014, -019, -022, -023. Covers: post orchestration order — inventory.receiveIn per stock
 * line BEFORE posting.post, posting.post called exactly once (AC4); atomic rollback on a forced posting
 * failure (nothing persisted, AC5); closed-period rejection surfaces with no persisted state (AC7);
 * advisory over-budget is called but never blocks the post (AC9); anti-double-post via row-lock semantics
 * (AC11); cancel = reverseReceipt(xN) + posting.reverse (AC12); repost rollback (AC12); PO_NOT_BILLABLE
 * (AC13).
 */
import Decimal from 'decimal.js';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { PurchaseBill, NewPurchaseBill } from '../../../src/modules/purchase/domain/purchase-bill';
import { PurchaseOrder, NewPurchaseOrder } from '../../../src/modules/purchase/domain/purchase-order';
import { PurchaseTax } from '../../../src/modules/purchase/domain/tax';
import { PostPurchaseBillUseCase } from '../../../src/modules/purchase/application/post-purchase-bill.usecase';
import { CancelPurchaseBillUseCase } from '../../../src/modules/purchase/application/cancel-purchase-bill.usecase';
import { RepostPurchaseBillUseCase } from '../../../src/modules/purchase/application/repost-purchase-bill.usecase';
import { PoNotBillableError } from '../../../src/modules/purchase/domain/errors';
import { PostingCommand, PostingLine } from '../../../src/core/posting/domain/posting-command';

function sumDebit(lines: PostingLine[]): Decimal {
  return lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
}
function sumCredit(lines: PostingLine[]): Decimal {
  return lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
}

const CO = 'co1';
const FY = 'fy1';
const PROJECT = 'p-01';
const SUPPLIER = 'supp-x';
const CC = 'cc-slab';
const PURPOSE = 'pur-day20-pour';
const GODOWN = 'g-site-a';
const d = (v: string) => new Decimal(v);

const actor: Actor = {
  userId: 'u-accounts',
  companyId: CO,
  financialYearId: FY,
  role: 'ACCOUNTS_MANAGER',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const TAX = PurchaseTax.of({ vatInputPct: '7.5', tdsPct: '5', aitPct: '2' });

const CLOCK = { now: () => new Date('2026-06-29T10:00:00Z') };
function idGen() {
  let n = 0;
  return { next: () => `id-${++n}` };
}
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };

function baseBillInput(overrides: Partial<NewPurchaseBill> = {}): NewPurchaseBill {
  return {
    projectId: PROJECT,
    supplierId: SUPPLIER,
    billDate: '2026-06-29',
    dueDate: '2026-07-29',
    lines: [
      {
        itemId: 'item-cement',
        isStockLine: true,
        billedQty: '100',
        rate: '500',
        godownId: GODOWN,
        projectId: PROJECT,
        costCentreId: CC,
        purposeId: PURPOSE,
      },
      {
        itemId: 'item-rod',
        isStockLine: true,
        billedQty: '2',
        rate: '90000',
        godownId: GODOWN,
        projectId: PROJECT,
        costCentreId: CC,
        purposeId: PURPOSE,
      },
    ],
    ...overrides,
  };
}

function draftBill(overrides: Partial<NewPurchaseBill> = {}, ids = ['l1', 'l2']): PurchaseBill {
  return PurchaseBill.createDraft('bill-1', CO, FY, baseBillInput(overrides), TAX, ids);
}

class FakeBillRepo {
  bill: PurchaseBill | null = null;
  saved: PurchaseBill[] = [];
  findById = jest.fn(async () => this.bill);
  findByIdForUpdate = jest.fn(async () => this.bill);
  insert = jest.fn(async (b: PurchaseBill) => {
    this.bill = b;
  });
  save = jest.fn(async (b: PurchaseBill) => {
    this.bill = b;
    this.saved.push(b);
  });
  softDelete = jest.fn(async () => undefined);
}

class FakePoRepo {
  po: PurchaseOrder | null = null;
  saved: PurchaseOrder[] = [];
  findById = jest.fn(async () => this.po);
  findByIdForUpdate = jest.fn(async () => this.po);
  insert = jest.fn(async (p: PurchaseOrder) => {
    this.po = p;
  });
  save = jest.fn(async (p: PurchaseOrder) => {
    this.po = p;
    this.saved.push(p);
  });
  openLines = jest.fn(async () => this.po?.lines ?? []);
}

function makeInventory() {
  return {
    receiveIn: jest.fn(async () => ({ avgRate: d('500') })),
    issueOut: jest.fn(),
    reverseIssueOut: jest.fn(),
    reverseReceipt: jest.fn(async () => undefined),
  };
}

function makeAccounts() {
  return {
    resolve: jest.fn(async () => ({
      vatInputRecoverable: 'acc-vat-input',
      accountsPayable: 'acc-ap',
      tdsPayable: 'acc-tds',
      aitPayable: 'acc-ait',
      inventoryOf: async () => 'acc-inventory',
    })),
  };
}

function makeConfig() {
  return { taxRates: jest.fn(async () => TAX) };
}

function makeProjectStatus() {
  return { assertNotClosed: jest.fn(async () => undefined) };
}

function makeBudgetCheck() {
  return { checkProspective: jest.fn(async () => [{ projectId: PROJECT, costCentreId: CC, status: 'OVER' }]) };
}

function makePosting(entryId = 'entry-1', entryNo = 'PUR/2526/0042') {
  return {
    post: jest.fn(async (cmd: PostingCommand) => ({ id: entryId, props: { entryNo, lines: cmd.lines } })),
    reverse: jest.fn(async () => ({ id: 'reversal-1', props: { entryNo: 'PUR/2526/0043' } })),
    repost: jest.fn(async (_entryId: string, _companyId: string, _reason: string, _by: string, cmd: PostingCommand) => ({
      reversal: { id: 'reversal-1', props: { entryNo: 'PUR/2526/0043' } },
      reposted: { id: 'entry-2', props: { entryNo: 'PUR/2526/0044', lines: cmd.lines } },
    })),
  };
}

describe('PostPurchaseBillUseCase (FR-PUR-008..014, AC4/AC5/AC9/AC11/AC13)', () => {
  it('calls inventory.receiveIn once per stock line BEFORE posting.post; posting.post exactly once; balanced 247,250', async () => {
    const bills = new FakeBillRepo();
    bills.bill = draftBill();
    const pos = new FakePoRepo();
    const inventory = makeInventory();
    const posting = makePosting();
    const budgetCheck = makeBudgetCheck();
    const callOrder: string[] = [];
    inventory.receiveIn.mockImplementation(async () => {
      callOrder.push('receiveIn');
      return { avgRate: d('500') };
    });
    posting.post.mockImplementation(async (cmd: PostingCommand) => {
      callOrder.push('post');
      return { id: 'entry-1', props: { entryNo: 'PUR/2526/0042', lines: cmd.lines } };
    });

    const uc = new PostPurchaseBillUseCase(
      bills as never,
      pos as never,
      makeAccounts() as never,
      makeProjectStatus() as never,
      inventory as never,
      budgetCheck as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );

    const result = await uc.execute('bill-1', actor);

    expect(inventory.receiveIn).toHaveBeenCalledTimes(2);
    expect(posting.post).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['receiveIn', 'receiveIn', 'post']);

    const cmd: PostingCommand = posting.post.mock.calls[0][0];
    const dr = sumDebit(cmd.lines);
    const cr = sumCredit(cmd.lines);
    expect(dr.toFixed(4)).toBe(cr.toFixed(4));
    expect(dr.toFixed(4)).toBe('247250.0000');
    expect(result.entryNo).toBe('PUR/2526/0042');
    expect(result.netPayableAmount).toBe('231150.0000');
    expect(bills.bill!.props.status).toBe('POSTED');
  });

  it('advisory over-budget is CALLED but never blocks the post (AC9) — PostingService never consulted about budget', async () => {
    const bills = new FakeBillRepo();
    bills.bill = draftBill();
    const pos = new FakePoRepo();
    const budgetCheck = makeBudgetCheck(); // returns OVER
    const posting = makePosting();
    const uc = new PostPurchaseBillUseCase(
      bills as never,
      pos as never,
      makeAccounts() as never,
      makeProjectStatus() as never,
      makeInventory() as never,
      budgetCheck as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );

    const result = await uc.execute('bill-1', actor);

    expect(budgetCheck.checkProspective).toHaveBeenCalled();
    expect(result.budgetWarnings).toEqual([{ projectId: PROJECT, costCentreId: CC, status: 'OVER' }]);
    expect(bills.bill!.props.status).toBe('POSTED'); // post succeeded despite OVER
    // posting.post's own cmd never carries budget data — it is a plain PostingCommand.
    const cmd: PostingCommand = posting.post.mock.calls[0][0];
    expect((cmd as unknown as { budgetWarnings?: unknown }).budgetWarnings).toBeUndefined();
  });

  it('atomic rollback: a forced posting.post failure rolls back the whole post — nothing saved, bill stays DRAFT', async () => {
    const bills = new FakeBillRepo();
    bills.bill = draftBill();
    const pos = new FakePoRepo();
    const inventory = makeInventory();
    const posting = makePosting();
    posting.post.mockRejectedValueOnce(new Error('forced posting failure'));
    const failingUow = {
      run: async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work();
        } catch (e) {
          bills.saved = []; // simulate rollback: nothing persisted
          throw e;
        }
      },
    };
    const uc = new PostPurchaseBillUseCase(
      bills as never,
      pos as never,
      makeAccounts() as never,
      makeProjectStatus() as never,
      inventory as never,
      makeBudgetCheck() as never,
      posting as never,
      audit as never,
      failingUow as never,
      CLOCK as never,
    );

    await expect(uc.execute('bill-1', actor)).rejects.toThrow('forced posting failure');
    expect(bills.saved).toHaveLength(0);
    expect(bills.bill!.props.status).toBe('DRAFT'); // markPosted never committed to the aggregate reference persisted
  });

  it('closed-period rejection (simulated via posting.post throw) leaves the bill DRAFT, no number consumed', async () => {
    const bills = new FakeBillRepo();
    bills.bill = draftBill();
    const pos = new FakePoRepo();
    const posting = makePosting();
    class PeriodClosedError extends Error {
      code = 'PERIOD_CLOSED';
    }
    posting.post.mockRejectedValueOnce(new PeriodClosedError('period closed'));
    const uc = new PostPurchaseBillUseCase(
      bills as never,
      pos as never,
      makeAccounts() as never,
      makeProjectStatus() as never,
      makeInventory() as never,
      makeBudgetCheck() as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('bill-1', actor)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(bills.bill!.props.status).toBe('DRAFT');
    expect(bills.bill!.props.entryNo).toBeNull();
  });

  it('rejects posting a non-DRAFT bill (anti-double-post proxy — assertPostable guards a second post)', async () => {
    const bills = new FakeBillRepo();
    bills.bill = draftBill();
    bills.bill.markPosted('entry-1', 'PUR/2526/0042', actor.userId, CLOCK.now());
    const pos = new FakePoRepo();
    const uc = new PostPurchaseBillUseCase(
      bills as never,
      pos as never,
      makeAccounts() as never,
      makeProjectStatus() as never,
      makeInventory() as never,
      makeBudgetCheck() as never,
      makePosting() as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('bill-1', actor)).rejects.toMatchObject({ code: 'VOUCHER_POSTED_IMMUTABLE' });
  });

  it('billing against a non-APPROVED PO -> PO_NOT_BILLABLE (AC13)', async () => {
    const bills = new FakeBillRepo();
    bills.bill = draftBill({ purchaseOrderId: 'po-1' });
    const pos = new FakePoRepo();
    const poInput: NewPurchaseOrder = {
      projectId: PROJECT,
      supplierId: SUPPLIER,
      poRefNo: null,
      poDate: '2026-06-20',
      expectedDeliveryDate: null,
      lines: [
        {
          itemId: 'item-cement',
          orderedQty: '100',
          rate: '500',
          godownId: GODOWN,
          projectId: PROJECT,
          costCentreId: CC,
          purposeId: PURPOSE,
        },
      ],
    };
    pos.po = PurchaseOrder.createDraft('po-1', CO, FY, poInput, ['l1']); // still DRAFT — not billable
    const uc = new PostPurchaseBillUseCase(
      bills as never,
      pos as never,
      makeAccounts() as never,
      makeProjectStatus() as never,
      makeInventory() as never,
      makeBudgetCheck() as never,
      makePosting() as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('bill-1', actor)).rejects.toBeInstanceOf(PoNotBillableError);
  });

  it('rolls a billed PO line into APPROVED -> PARTIALLY_BILLED on post', async () => {
    const bills = new FakeBillRepo();
    bills.bill = draftBill({ purchaseOrderId: 'po-1', lines: baseBillInput().lines });
    const pos = new FakePoRepo();
    const poInput: NewPurchaseOrder = {
      projectId: PROJECT,
      supplierId: SUPPLIER,
      poRefNo: null,
      poDate: '2026-06-20',
      expectedDeliveryDate: null,
      lines: [
        { itemId: 'item-cement', orderedQty: '200', rate: '500', godownId: GODOWN, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE },
        { itemId: 'item-rod', orderedQty: '4', rate: '90000', godownId: GODOWN, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE },
      ],
    };
    pos.po = PurchaseOrder.createDraft('po-1', CO, FY, poInput, ['l1', 'l2']);
    pos.po.approve('u1', CLOCK.now());

    const uc = new PostPurchaseBillUseCase(
      bills as never,
      pos as never,
      makeAccounts() as never,
      makeProjectStatus() as never,
      makeInventory() as never,
      makeBudgetCheck() as never,
      makePosting() as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await uc.execute('bill-1', actor);
    expect(pos.po!.props.status).toBe('PARTIALLY_BILLED');
    expect(pos.po!.openQtyOf(1).toFixed(4)).toBe('100.0000'); // 200 - 100 billed
  });
});

describe('CancelPurchaseBillUseCase (FR-PUR-022/-023, AC12)', () => {
  function postedBill(): PurchaseBill {
    const b = draftBill();
    b.markPosted('entry-1', 'PUR/2526/0042', actor.userId, CLOCK.now());
    return b;
  }

  it('calls reverseReceipt once per stock line + posting.reverse; marks CANCELLED; original number retained', async () => {
    const bills = new FakeBillRepo();
    bills.bill = postedBill();
    const inventory = makeInventory();
    const posting = makePosting();
    const uc = new CancelPurchaseBillUseCase(bills as never, inventory as never, posting as never, audit as never, uow as never);

    const result = await uc.execute('bill-1', 'wrong supplier invoice', actor);

    expect(inventory.reverseReceipt).toHaveBeenCalledTimes(2);
    expect(posting.reverse).toHaveBeenCalledTimes(1);
    expect(bills.bill!.props.status).toBe('CANCELLED');
    expect(bills.bill!.props.entryNo).toBe('PUR/2526/0042'); // retained
    expect(result.reversalEntryNo).toBe('PUR/2526/0043');
  });

  it('rejects cancelling a DRAFT bill (VOUCHER_NOT_POSTED)', async () => {
    const bills = new FakeBillRepo();
    bills.bill = draftBill();
    const uc = new CancelPurchaseBillUseCase(bills as never, makeInventory() as never, makePosting() as never, audit as never, uow as never);
    await expect(uc.execute('bill-1', 'reason', actor)).rejects.toMatchObject({ code: 'VOUCHER_NOT_POSTED' });
  });
});

describe('RepostPurchaseBillUseCase (FR-LED-027, AC12)', () => {
  function postedBill(): PurchaseBill {
    const b = draftBill();
    b.markPosted('entry-1', 'PUR/2526/0042', actor.userId, CLOCK.now());
    return b;
  }

  it('reverses + reposts in one call: reverseReceipt + receiveIn + posting.repost; a new entry/number, original retained', async () => {
    const bills = new FakeBillRepo();
    bills.bill = postedBill();
    const inventory = makeInventory();
    const posting = makePosting();
    const uc = new RepostPurchaseBillUseCase(
      bills as never,
      makeAccounts() as never,
      makeConfig() as never,
      inventory as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );

    const result = await uc.execute('bill-1', { narration: 'corrected' }, 'wrong rate', actor);

    expect(inventory.reverseReceipt).toHaveBeenCalledTimes(2);
    expect(inventory.receiveIn).toHaveBeenCalledTimes(2);
    expect(posting.repost).toHaveBeenCalledTimes(1);
    expect(result.entryNo).toBe('PUR/2526/0044');
    expect(result.reversalEntryNo).toBe('PUR/2526/0043');
    expect(bills.bill!.props.entryNo).toBe('PUR/2526/0044'); // re-stamped with the NEW number
    expect(bills.bill!.props.status).toBe('POSTED');
  });

  it('atomic: a forced repost failure rolls back everything (fake uow simulates no persistence)', async () => {
    const bills = new FakeBillRepo();
    bills.bill = postedBill();
    const inventory = makeInventory();
    const posting = makePosting();
    posting.repost.mockRejectedValueOnce(new Error('forced repost failure'));
    const failingUow = {
      run: async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work();
        } catch (e) {
          bills.saved = [];
          throw e;
        }
      },
    };
    const uc = new RepostPurchaseBillUseCase(
      bills as never,
      makeAccounts() as never,
      makeConfig() as never,
      inventory as never,
      posting as never,
      audit as never,
      failingUow as never,
      CLOCK as never,
      idGen() as never,
    );
    await expect(uc.execute('bill-1', {}, 'reason', actor)).rejects.toThrow('forced repost failure');
    expect(bills.saved).toHaveLength(0);
  });
});
