/**
 * GEN use-case unit tests (fake PostingService + fake ports/UoW/Clock/IdGenerator). Cites
 * FR-GEN-009..015/-018. Covers: single-writer-inside-UoW; number/ledger only on success; opening
 * assembler balances + party split + both-roles party; one-opening-per-company; reverse → CANCELLED with
 * the original untouched.
 */
import Decimal from 'decimal.js';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { PostContraUseCase } from '../../../src/modules/contra-journal/application/post-contra.usecase';
import { PostJournalUseCase } from '../../../src/modules/contra-journal/application/post-journal.usecase';
import { PostOpeningJournalUseCase } from '../../../src/modules/contra-journal/application/post-opening-journal.usecase';
import { OpeningJournalAssembler } from '../../../src/modules/contra-journal/application/opening-journal.assembler';
import { ReverseJournalUseCase } from '../../../src/modules/contra-journal/application/reverse-voucher.usecase';
import { ContraVoucher } from '../../../src/modules/contra-journal/domain/contra-voucher';
import { JournalVoucher } from '../../../src/modules/contra-journal/domain/journal-voucher';
import { AccountClassificationSnapshot } from '../../../src/modules/contra-journal/domain/ports/account-classification.port';
import { OpeningAlreadyExistsError } from '../../../src/modules/contra-journal/domain/errors';

const actor: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const CLOCK = { now: () => new Date('2026-07-01T00:00:00Z') };
const IDS = (() => {
  let n = 0;
  return { next: () => `id-${++n}` };
})();
const uow = { run: <T>(work: () => Promise<T>) => work() };

class FakePosting {
  posts: PostingCommand[] = [];
  reversed: string[] = [];
  post = jest.fn(async (cmd: PostingCommand) => {
    this.posts.push(cmd);
    // balance assertion mirrors LED (exact Decimal)
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    if (!dr.equals(cr)) throw new Error('imbalanced');
    return { id: `entry-${this.posts.length}`, props: { entryNo: `NO-${this.posts.length}` } } as never;
  });
  reverse = jest.fn(async (entryId: string) => {
    this.reversed.push(entryId);
    return { id: `rev-${this.reversed.length}`, props: { entryNo: `RNO-${this.reversed.length}` } } as never;
  });
}

const audit = { record: jest.fn(async () => undefined) };

function cashBankContra(): ContraVoucher {
  const snap = AccountClassificationSnapshot.of({
    bank: { type: 'ASSET', isCashBank: true, isArApControl: false },
    cash: { type: 'ASSET', isCashBank: true, isArApControl: false },
  });
  return ContraVoucher.createDraft('cv1', 'co1', 'fy1', {
    voucherDate: '2026-06-29',
    lines: [
      { accountId: 'bank', debit: '500000.0000' },
      { accountId: 'cash', credit: '500000.0000' },
    ],
  }, snap);
}

describe('GEN post use cases (single writer, atomic)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PostContra calls posting.post exactly once and stamps the number on success (FR-GEN-015)', async () => {
    const posting = new FakePosting();
    const voucher = cashBankContra();
    const repo = {
      findByIdForUpdate: jest.fn(async () => voucher),
      save: jest.fn(async () => undefined),
    };
    const uc = new PostContraUseCase(repo as never, posting as never, audit as never, uow as never, CLOCK);
    const res = await uc.execute('cv1', actor);
    expect(posting.post).toHaveBeenCalledTimes(1);
    expect(posting.posts[0].voucherType).toBe('CONTRA');
    expect(res.entryNo).toBe('NO-1');
    expect(voucher.props.status).toBe('POSTED');
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('a failing post leaves the voucher DRAFT and never stamps a number (FR-GEN-016)', async () => {
    const posting = new FakePosting();
    posting.post.mockRejectedValueOnce(new Error('closed period'));
    const voucher = cashBankContra();
    const repo = { findByIdForUpdate: jest.fn(async () => voucher), save: jest.fn() };
    const uc = new PostContraUseCase(repo as never, posting as never, audit as never, uow as never, CLOCK);
    await expect(uc.execute('cv1', actor)).rejects.toThrow('closed period');
    expect(voucher.props.status).toBe('DRAFT');
    expect(voucher.props.entryNo).toBeNull();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('PostJournal posts the JOURNAL command once and marks POSTED', async () => {
    const posting = new FakePosting();
    const snap = AccountClassificationSnapshot.of({
      liab: { type: 'LIABILITY', isCashBank: false, isArApControl: false },
    });
    const voucher = JournalVoucher.createDraft('jv1', 'co1', 'fy1', {
      voucherType: 'JOURNAL',
      voucherDate: '2026-06-29',
      lines: [
        { accountId: 'liab', debit: '100.0000' },
        { accountId: 'liab', credit: '100.0000' },
      ],
    }, snap);
    const repo = { findByIdForUpdate: jest.fn(async () => voucher), save: jest.fn() };
    const uc = new PostJournalUseCase(repo as never, posting as never, audit as never, uow as never, CLOCK);
    await uc.execute('jv1', actor);
    expect(posting.posts[0].voucherType).toBe('JOURNAL');
    expect(voucher.props.status).toBe('POSTED');
  });

  it('ReverseJournal calls posting.reverse and marks CANCELLED (FR-GEN-018)', async () => {
    const posting = new FakePosting();
    const snap = AccountClassificationSnapshot.of({
      liab: { type: 'LIABILITY', isCashBank: false, isArApControl: false },
    });
    const voucher = JournalVoucher.createDraft('jv1', 'co1', 'fy1', {
      voucherType: 'JOURNAL',
      voucherDate: '2026-06-29',
      lines: [
        { accountId: 'liab', debit: '100.0000' },
        { accountId: 'liab', credit: '100.0000' },
      ],
    }, snap);
    voucher.markPosted('entry-x', 'JV-1', 'u1', new Date());
    const repo = { findByIdForUpdate: jest.fn(async () => voucher), save: jest.fn() };
    const uc = new ReverseJournalUseCase(repo as never, posting as never, audit as never, uow as never);
    await uc.execute('jv1', 'wrong amount', actor);
    expect(posting.reverse).toHaveBeenCalledWith('entry-x', 'co1', 'wrong amount', 'u1');
    expect(voucher.props.status).toBe('CANCELLED');
    // original ledger linkage untouched
    expect(voucher.props.journalEntryId).toBe('entry-x');
    expect(voucher.props.entryNo).toBe('JV-1');
  });
});

describe('OpeningJournalAssembler + PostOpeningJournalUseCase (FR-GEN-009..013)', () => {
  const mas = {
    accountsWithOpening: jest.fn(async () => [
      { accountId: 'cash', type: 'ASSET' as const, amount: new Decimal('300000') },
      { accountId: 'bank', type: 'ASSET' as const, amount: new Decimal('1200000') },
    ]),
    partiesWithOpening: jest.fn(async () => [
      { partyId: 'pa', amount: new Decimal('800000') }, // owes us → AR debit
      { partyId: 'pb', amount: new Decimal('-450000') }, // we owe → AP credit
    ]),
  };
  const resolver = {
    arControlAccount: jest.fn(async () => 'ar-ctl'),
    apControlAccount: jest.fn(async () => 'ap-ctl'),
    openingEquityAccount: jest.fn(async () => 'opening-eq'),
  };

  it('assembles a balanced OPENING voucher, party on AR/AP control lines, equity absorbs the net', async () => {
    const assembler = new OpeningJournalAssembler(mas as never, resolver as never, IDS);
    const v = await assembler.assemble('co1', 'fy1', '2025-07-01', 'Go-live');
    expect(v.props.voucherType).toBe('OPENING');
    const cmd = v.toPostingCommand('u1');
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.equals(cr)).toBe(true);
    expect(dr.toFixed(4)).toBe('2300000.0000');

    const arLine = cmd.lines.find((l) => l.accountId === 'ar-ctl')!;
    expect(arLine.partyId).toBe('pa');
    expect(arLine.isControlAccount).toBe(true);
    expect(arLine.debit.amount.toFixed(4)).toBe('800000.0000');
    const apLine = cmd.lines.find((l) => l.accountId === 'ap-ctl')!;
    expect(apLine.partyId).toBe('pb');
    expect(apLine.credit.amount.toFixed(4)).toBe('450000.0000');
    const eq = cmd.lines.find((l) => l.accountId === 'opening-eq')!;
    expect(eq.credit.amount.toFixed(4)).toBe('1850000.0000');
  });

  it('a both-roles party supplied as two rows yields an AR line AND an AP line each carrying the party', async () => {
    const bothRoles = {
      accountsWithOpening: jest.fn(async () => []),
      partiesWithOpening: jest.fn(async () => [
        { partyId: 'p-both', amount: new Decimal('600000') },
        { partyId: 'p-both', amount: new Decimal('-200000') },
      ]),
    };
    const assembler = new OpeningJournalAssembler(bothRoles as never, resolver as never, IDS);
    const cmd = (await assembler.assemble('co1', 'fy1', '2025-07-01', null)).toPostingCommand('u1');
    const ar = cmd.lines.filter((l) => l.accountId === 'ar-ctl' && l.partyId === 'p-both');
    const ap = cmd.lines.filter((l) => l.accountId === 'ap-ctl' && l.partyId === 'p-both');
    expect(ar).toHaveLength(1);
    expect(ap).toHaveLength(1);
  });

  it('rejects a second opening journal for the company (OpeningAlreadyExistsError, FR-GEN-012)', async () => {
    const posting = new FakePosting();
    const assembler = new OpeningJournalAssembler(mas as never, resolver as never, IDS);
    const repo = {
      existsOpeningFor: jest.fn(async () => true),
      insert: jest.fn(),
      save: jest.fn(),
    };
    const uc = new PostOpeningJournalUseCase(
      repo as never,
      assembler,
      posting as never,
      audit as never,
      uow as never,
      CLOCK,
    );
    await expect(uc.execute({ voucherDate: '2025-07-01' }, actor)).rejects.toThrow(OpeningAlreadyExistsError);
    expect(posting.post).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('posts the opening journal once when none exists (single writer)', async () => {
    const posting = new FakePosting();
    const assembler = new OpeningJournalAssembler(mas as never, resolver as never, IDS);
    const repo = {
      existsOpeningFor: jest.fn(async () => false),
      insert: jest.fn(async () => undefined),
      save: jest.fn(async () => undefined),
    };
    const uc = new PostOpeningJournalUseCase(
      repo as never,
      assembler,
      posting as never,
      audit as never,
      uow as never,
      CLOCK,
    );
    const res = await uc.execute({ voucherDate: '2025-07-01' }, actor);
    expect(posting.post).toHaveBeenCalledTimes(1);
    expect(posting.posts[0].voucherType).toBe('OPENING');
    expect(res.entryNo).toBe('NO-1');
    expect(repo.save).toHaveBeenCalled();
  });
});
