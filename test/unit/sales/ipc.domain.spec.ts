/**
 * SAL domain unit tests (no DB, no Nest) — the Ipc aggregate money math + lifecycle + buildIpcCommand.
 * Cites FR-SAL-003/-004/-008/-010/-011/-023. Covers: the §4 figures + residual currently-due (AC2);
 * buildIpcCommand equals §4 & balances with dimensions+party (AC1, AC3); zero-line omission; advance cap
 * (AC4); currently-due-non-negative + certified-positive guards; lifecycle guards.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { Ipc, NewIpc } from '../../../src/modules/sales/domain/ipc';
import { buildIpcCommand, SalesAccountMap } from '../../../src/modules/sales/domain/ipc-posting';
import { IpcRates } from '../../../src/modules/sales/domain/rates';
import {
  AdvanceExceededError,
  CertifiedNotPositiveError,
  CurrentlyDueNegativeError,
  NotDraftError,
} from '../../../src/modules/sales/domain/errors';

const CO = 'co1';
const FY = 'fy1';
const PROJECT = 'p-01';
const CUSTOMER = 'cust-a';
const CC = 'cc-slab';
const PURPOSE = 'pur-ipc-7';

const RATES = IpcRates.of({ retentionPct: '10', advancePct: '15', vatPct: '7.5' });

const ACCOUNTS: SalesAccountMap = {
  accountsReceivable: 'acc-ar',
  retentionReceivable: 'acc-ret',
  mobilizationAdvance: 'acc-adv',
  aitRecoverable: 'acc-ait',
  revenueConstruction: 'acc-rev',
  outputVatPayable: 'acc-vat',
};

function baseInput(overrides: Partial<NewIpc> = {}): NewIpc {
  return {
    projectId: PROJECT,
    customerId: CUSTOMER,
    ipcSeqNo: 7,
    ipcDate: '2026-06-29',
    billDate: '2026-06-29',
    dueDate: '2026-07-29',
    workCompletedPct: '62.5',
    certifiedAmount: '1000000',
    costCentreId: CC,
    purposeId: PURPOSE,
    aitTdsAmount: '50000', // 5% AIT deducted by the customer
    ...overrides,
  };
}

function draft(overrides: Partial<NewIpc> = {}, remaining = Money.of(new Decimal('1000000'))): Ipc {
  return Ipc.createDraft('ipc-1', CO, FY, baseInput(overrides), RATES, remaining);
}

describe('Ipc — figures & residual currently-due (AC2, FR-SAL-004)', () => {
  it('computes retention 100k, advance 150k, VAT 75k, currentlyDue 775k exactly', () => {
    const ipc = draft();
    const p = ipc.props;
    expect(p.retentionAmount.amount.toFixed(4)).toBe('100000.0000'); // 10% × 1,000,000
    expect(p.advanceRecoveredAmount.amount.toFixed(4)).toBe('150000.0000'); // 15% × 1,000,000
    expect(p.outputVatAmount.amount.toFixed(4)).toBe('75000.0000'); // 7.5% × 1,000,000
    expect(p.aitTdsAmount.amount.toFixed(4)).toBe('50000.0000');
    // currentlyDue = 1,000,000 + 75,000 − 100,000 − 150,000 − 50,000 = 775,000
    expect(p.currentlyDueAmount.amount.toFixed(4)).toBe('775000.0000');
    expect(p.retentionRatePct.toFixed(4)).toBe('10.0000');
    expect(p.status).toBe('DRAFT');
    expect(p.entryNo).toBeNull();
    expect(p.journalEntryId).toBeNull();
  });

  it('records the effective retention rate when retention is overridden (FR-SAL-006)', () => {
    const ipc = draft({ retentionAmount: '50000' }); // override to 5%
    expect(ipc.props.retentionAmount.amount.toFixed(4)).toBe('50000.0000');
    expect(ipc.props.retentionRatePct.toFixed(4)).toBe('5.0000');
    // currentlyDue rises: 1,000,000 + 75,000 − 50,000 − 150,000 − 50,000 = 825,000
    expect(ipc.props.currentlyDueAmount.amount.toFixed(4)).toBe('825000.0000');
  });

  it('rejects AIT/TDS that would drive currently-due below 0 (edge case 10)', () => {
    // certified 100k, VAT 7.5k; retention 10k + advance 15k + AIT 90k → due < 0
    expect(() => draft({ certifiedAmount: '100000', aitTdsAmount: '90000' }, Money.of(new Decimal('1000000')))).toThrow(
      CurrentlyDueNegativeError,
    );
  });

  it('rejects certified <= 0 (edge case 14)', () => {
    expect(() => draft({ certifiedAmount: '0' })).toThrow(CertifiedNotPositiveError);
    expect(() => draft({ certifiedAmount: '-5' })).toThrow(CertifiedNotPositiveError);
  });
});

describe('Ipc — advance cap (AC4, FR-SAL-008)', () => {
  it('caps advance recovery at the remaining advance', () => {
    // rate-computed 150k, but only 120k remains → recover 120k
    const ipc = draft({}, Money.of(new Decimal('120000')));
    expect(ipc.props.advanceRecoveredAmount.amount.toFixed(4)).toBe('120000.0000');
    // currentlyDue = 1,000,000 + 75,000 − 100,000 − 120,000 − 50,000 = 805,000
    expect(ipc.props.currentlyDueAmount.amount.toFixed(4)).toBe('805000.0000');
  });

  it('recovers 0 on a fully-recovered project', () => {
    const ipc = draft({}, Money.zero());
    expect(ipc.props.advanceRecoveredAmount.amount.toFixed(4)).toBe('0.0000');
  });

  it('re-checks the cap inside the post tx via assertAdvanceWithinRemaining', () => {
    const ipc = draft(); // recorded advance 150k
    expect(() => ipc.assertAdvanceWithinRemaining(Money.of(new Decimal('100000')))).toThrow(AdvanceExceededError);
    expect(() => ipc.assertAdvanceWithinRemaining(Money.of(new Decimal('150000')))).not.toThrow();
  });
});

describe('Ipc — lifecycle guards (AC11, FR-SAL-023)', () => {
  it('markPosted only from DRAFT; a second post throws NotDraftError', () => {
    const ipc = draft();
    ipc.markPosted('entry-1', 'IPC/2526/0007', 'u1', new Date());
    expect(ipc.props.status).toBe('POSTED');
    expect(ipc.props.entryNo).toBe('IPC/2526/0007');
    expect(() => ipc.markPosted('entry-2', 'IPC/2526/0008', 'u1', new Date())).toThrow(NotDraftError);
  });

  it('updateDraft rejected on a POSTED IPC', () => {
    const ipc = draft();
    ipc.markPosted('entry-1', 'IPC/2526/0007', 'u1', new Date());
    expect(() => ipc.updateDraft({ certifiedAmount: '2000000' }, RATES, Money.of(new Decimal('1000000')))).toThrow(
      NotDraftError,
    );
  });

  it('markCancelled only from POSTED', () => {
    const ipc = draft();
    expect(() => ipc.markCancelled()).toThrow(NotDraftError);
    ipc.markPosted('entry-1', 'IPC/2526/0007', 'u1', new Date());
    ipc.markCancelled();
    expect(ipc.props.status).toBe('CANCELLED');
  });

  it('updateDraft recomputes figures on the new certified base', () => {
    const ipc = draft();
    ipc.updateDraft({ certifiedAmount: '2000000' }, RATES, Money.of(new Decimal('1000000')));
    expect(ipc.props.retentionAmount.amount.toFixed(4)).toBe('200000.0000');
    expect(ipc.props.outputVatAmount.amount.toFixed(4)).toBe('150000.0000');
  });
});

describe('buildIpcCommand — the §4 template (AC1, AC3, FR-SAL-010/-011)', () => {
  it('emits the §4 split-AR lines, balanced at 1,375,000, with dimensions + party', () => {
    const ipc = draft();
    const cmd = buildIpcCommand(ipc, ACCOUNTS, 'u1');
    expect(cmd.voucherType).toBe('SALES_IPC');

    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe('1375000.0000');
    expect(cr.toFixed(4)).toBe('1375000.0000');
    expect(dr.equals(cr)).toBe(true);

    // gross AR debit = certified + VAT = 1,075,000
    const arDebit = cmd.lines.find((l) => l.accountId === ACCOUNTS.accountsReceivable && l.debit.amount.isPositive());
    expect(arDebit?.debit.amount.toFixed(4)).toBe('1075000.0000');
    expect(arDebit?.partyId).toBe(CUSTOMER);
    expect(arDebit?.projectId).toBe(PROJECT);

    // revenue full certified, no party, dims present
    const rev = cmd.lines.find((l) => l.accountId === ACCOUNTS.revenueConstruction);
    expect(rev?.credit.amount.toFixed(4)).toBe('1000000.0000');
    expect(rev?.partyId).toBeUndefined();
    expect(rev?.costCentreId).toBe(CC);
    expect(rev?.purposeId).toBe(PURPOSE);

    // retention debit (party) + AR contra credit (party)
    const ret = cmd.lines.find((l) => l.accountId === ACCOUNTS.retentionReceivable);
    expect(ret?.debit.amount.toFixed(4)).toBe('100000.0000');
    expect(ret?.partyId).toBe(CUSTOMER);

    // advance debit (party) + AR contra credit (party)
    const adv = cmd.lines.find((l) => l.accountId === ACCOUNTS.mobilizationAdvance);
    expect(adv?.debit.amount.toFixed(4)).toBe('150000.0000');
    expect(adv?.partyId).toBe(CUSTOMER);

    // AIT debit, dims, no party
    const ait = cmd.lines.find((l) => l.accountId === ACCOUNTS.aitRecoverable);
    expect(ait?.debit.amount.toFixed(4)).toBe('50000.0000');
    expect(ait?.partyId).toBeUndefined();

    // NO godown on any line
    for (const l of cmd.lines) expect(l.godownId).toBeUndefined();

    // AR contra credits net the gross AR to the currently-due 775,000
    const arCredits = cmd.lines
      .filter((l) => l.accountId === ACCOUNTS.accountsReceivable && l.credit.amount.isPositive())
      .reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(arDebit!.debit.amount.minus(arCredits).toFixed(4)).toBe('775000.0000');
  });

  it('every AR / retention / advance control line carries the customer party (AC1/AC3)', () => {
    const cmd = buildIpcCommand(draft(), ACCOUNTS, 'u1');
    for (const l of cmd.lines) {
      if (l.isControlAccount) expect(l.partyId).toBe(CUSTOMER);
    }
  });

  it('omits zero-amount lines and still balances (edge case 15) — no advance, no AIT', () => {
    // remaining advance 0 → no advance pair; aitTds 0 → no AIT line
    const ipc = draft({ aitTdsAmount: '0' }, Money.zero());
    const cmd = buildIpcCommand(ipc, ACCOUNTS, 'u1');
    expect(cmd.lines.some((l) => l.accountId === ACCOUNTS.mobilizationAdvance)).toBe(false);
    expect(cmd.lines.some((l) => l.accountId === ACCOUNTS.aitRecoverable)).toBe(false);
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.equals(cr)).toBe(true);
    // currentlyDue = 1,000,000 + 75,000 − 100,000 − 0 − 0 = 975,000
    expect(ipc.props.currentlyDueAmount.amount.toFixed(4)).toBe('975000.0000');
  });
});
