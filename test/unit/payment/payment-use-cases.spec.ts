/**
 * PAY use-case unit tests (fake ports + fake UnitOfWork/Clock/IdGenerator). Covers: post orchestration
 * order (lock -> assertPostable -> re-check caps -> build -> posting.post once -> markPosted -> save ->
 * audit); over-settlement rejected at post (posting.post NOT called); atomic rollback (forced posting
 * failure leaves the payment DRAFT, no save); anti-double-post (a second post fails assertPostable).
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { NewPayment, PaymentVoucher } from '../../../src/modules/payment/domain/payment-voucher';
import { ResolvedPayable } from '../../../src/modules/payment/domain/ports/payable-lookup.port';
import { PostPaymentUseCase } from '../../../src/modules/payment/application/post-payment.usecase';
import { AllocationExceedsOutstandingError } from '../../../src/modules/payment/domain/errors';

const actor: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const CLOCK = { now: () => new Date('2026-06-30T10:00:00Z') };
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };
const accountMap = { resolve: jest.fn(async () => ({ labourCostAccountId: 'acc-lc', bankChargesAccountId: 'acc-bc' })) };

function resolvedBill(remaining: string): ResolvedPayable {
  return {
    controlAccountId: 'acc-ap',
    controlAccountType: 'LIABILITY',
    isControlAccount: true,
    partyId: 'supplier-1',
    projectId: null,
    costCentreId: null,
    purposeId: null,
    accruedAmount: null,
    originalAmount: Money.of(new Decimal(remaining)),
    remainingOutstanding: Money.of(new Decimal(remaining)),
    posted: true,
  };
}

function makeLookup(remaining = '200000') {
  return { resolve: jest.fn(async (): Promise<ResolvedPayable | null> => resolvedBill(remaining)) };
}

function paymentInput(overrides: Partial<NewPayment> = {}): NewPayment {
  return {
    paymentDate: '2026-06-30',
    paymentMode: 'BANK_TRANSFER',
    paymentAccountId: 'acc-bank',
    chequeTxnRef: 'TXN-1',
    paymentAmount: '200000',
    bankChargesAmount: '0',
    allocations: [{ payableType: 'PURCHASE_BILL', payableId: 'bill-1', amountAllocated: '200000' }],
    ...overrides,
  };
}

function newDraft(overrides: Partial<NewPayment> = {}): PaymentVoucher {
  return PaymentVoucher.createDraft('pay-1', actor.companyId, actor.financialYearId, paymentInput(overrides));
}

class FakeRepo {
  payment: PaymentVoucher | null = null;
  insert = jest.fn(async (p: PaymentVoucher) => {
    this.payment = p;
  });
  save = jest.fn(async (p: PaymentVoucher) => {
    this.payment = p;
  });
  findById = jest.fn(async () => this.payment);
  findByIdForUpdate = jest.fn(async () => this.payment);
  delete = jest.fn(async () => undefined);
}

class FakePosting {
  posts: PostingCommand[] = [];
  post = jest.fn(async (cmd: PostingCommand) => {
    this.posts.push(cmd);
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    if (!dr.equals(cr)) throw new Error('imbalanced');
    return { id: `entry-${this.posts.length}`, props: { entryNo: `PV/2526/000${this.posts.length}` } } as never;
  });
}

beforeEach(() => jest.clearAllMocks());

describe('PostPaymentUseCase', () => {
  it('locks the draft, re-resolves + re-caps, builds, posts once, marks POSTED, saves, audits', async () => {
    const repo = new FakeRepo();
    repo.payment = newDraft();
    const posting = new FakePosting();
    const lookup = makeLookup();
    const uc = new PostPaymentUseCase(
      repo as never,
      lookup as never,
      accountMap as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    const res = await uc.execute('pay-1', actor);

    expect(repo.findByIdForUpdate).toHaveBeenCalledTimes(1);
    expect(lookup.resolve).toHaveBeenCalledTimes(1);
    expect(posting.post).toHaveBeenCalledTimes(1);
    expect(posting.posts[0].voucherType).toBe('PAYMENT');
    expect(repo.payment?.props.status).toBe('POSTED');
    expect(repo.payment?.props.entryNo).toBe(res.entryNo);
    expect(res.entryNo).toBe('PV/2526/0001');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'POST' }));
  });

  it('over-settlement is rejected at post — the cap is re-checked, posting.post NOT called', async () => {
    const repo = new FakeRepo();
    repo.payment = newDraft();
    const posting = new FakePosting();
    const lookup = makeLookup('150000'); // outstanding dropped below the allocation (200000)
    const uc = new PostPaymentUseCase(
      repo as never,
      lookup as never,
      accountMap as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('pay-1', actor)).rejects.toBeInstanceOf(AllocationExceedsOutstandingError);
    expect(posting.post).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.payment?.props.status).toBe('DRAFT');
  });

  it('atomic rollback: a forced posting failure leaves the payment DRAFT with no save', async () => {
    const repo = new FakeRepo();
    repo.payment = newDraft();
    const posting = new FakePosting();
    posting.post = jest.fn(async () => {
      throw Object.assign(new Error('period closed'), { code: 'PERIOD_CLOSED' });
    }) as never;
    const lookup = makeLookup();
    const uc = new PostPaymentUseCase(
      repo as never,
      lookup as never,
      accountMap as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('pay-1', actor)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(repo.payment?.props.status).toBe('DRAFT');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('anti-double-post: a second post fails assertPostable after the row is POSTED', async () => {
    const repo = new FakeRepo();
    const posted = newDraft();
    posted.markPosted('entry-1', 'PV/2526/0001', 'u1', new Date());
    repo.payment = posted;
    const posting = new FakePosting();
    const lookup = makeLookup();
    const uc = new PostPaymentUseCase(
      repo as never,
      lookup as never,
      accountMap as never,
      posting as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('pay-1', actor)).rejects.toMatchObject({ code: 'VOUCHER_POSTED_IMMUTABLE' });
    expect(posting.post).not.toHaveBeenCalled();
  });
});
