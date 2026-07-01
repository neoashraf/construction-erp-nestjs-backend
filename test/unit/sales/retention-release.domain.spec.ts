/**
 * RetentionRelease domain unit tests (no DB, no Nest) — 100% coverage per the brief's DoD. Covers:
 * assertReleasable boundaries (0, <= held, > held -> OverReleaseError, edge case 7); toPostingCommand
 * equals §4.2 and balances with dimensions + party (AC1, AC2); lifecycle guards.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { ValidationError } from '../../../src/common/errors/domain-error';
import {
  NewRetentionRelease,
  RetentionRelease,
  RetentionReleaseAccountMap,
} from '../../../src/modules/sales/domain/retention-release';
import { OverReleaseError } from '../../../src/modules/sales/domain/errors';

const CO = 'co1';
const FY = 'fy1';
const IPC = 'ipc-7';
const PROJECT = 'p-01';
const CUSTOMER = 'cust-a';
const CC = 'cc-slab';
const PURPOSE = 'pur-ipc-7';

const ACCOUNTS: RetentionReleaseAccountMap = {
  accountsReceivable: 'acc-ar',
  retentionReceivable: 'acc-ret',
};

function baseInput(overrides: Partial<NewRetentionRelease> = {}): NewRetentionRelease {
  return {
    companyId: CO,
    financialYearId: FY,
    ipcId: IPC,
    projectId: PROJECT,
    customerId: CUSTOMER,
    costCentreId: CC,
    purposeId: PURPOSE,
    releaseDate: '2027-06-29',
    releasedAmount: '100000',
    narration: 'Defect-liability period elapsed',
    ...overrides,
  };
}

describe('RetentionRelease.createDraft / assertReleasable — boundaries (AC2, FR-SAL-019, edge case 7)', () => {
  it('accepts an amount exactly equal to retention held (top boundary)', () => {
    const held = Money.of(new Decimal('100000'));
    const release = RetentionRelease.createDraft('r-1', baseInput({ releasedAmount: '100000' }), held);
    expect(release.props.releasedAmount.amount.toFixed(4)).toBe('100000.0000');
    expect(release.props.status).toBe('DRAFT');
  });

  it('accepts an amount strictly less than retention held', () => {
    const held = Money.of(new Decimal('100000'));
    const release = RetentionRelease.createDraft('r-1', baseInput({ releasedAmount: '40000' }), held);
    expect(release.props.releasedAmount.amount.toFixed(4)).toBe('40000.0000');
  });

  it('rejects an amount exceeding retention held -> OverReleaseError', () => {
    const held = Money.of(new Decimal('100000'));
    expect(() => RetentionRelease.createDraft('r-1', baseInput({ releasedAmount: '100000.01' }), held)).toThrow(
      OverReleaseError,
    );
    expect(() => RetentionRelease.createDraft('r-1', baseInput({ releasedAmount: '120000' }), held)).toThrow(
      OverReleaseError,
    );
  });

  it('rejects a zero amount (0 boundary) -> ValidationError', () => {
    const held = Money.of(new Decimal('100000'));
    expect(() => RetentionRelease.createDraft('r-1', baseInput({ releasedAmount: '0' }), held)).toThrow(
      ValidationError,
    );
  });

  it('rejects a negative amount -> ValidationError', () => {
    const held = Money.of(new Decimal('100000'));
    expect(() => RetentionRelease.createDraft('r-1', baseInput({ releasedAmount: '-1' }), held)).toThrow(
      ValidationError,
    );
  });

  it('a further release after the held amount drops to 0 is rejected (edge case 7)', () => {
    const zeroHeld = Money.zero();
    expect(() => RetentionRelease.createDraft('r-2', baseInput({ releasedAmount: '1' }), zeroHeld)).toThrow(
      OverReleaseError,
    );
  });

  it('assertReleasable can be re-checked independently against a fresh held figure', () => {
    const release = RetentionRelease.createDraft('r-1', baseInput({ releasedAmount: '100000' }), Money.of(new Decimal('100000')));
    expect(() => release.assertReleasable(Money.of(new Decimal('100000')))).not.toThrow();
    expect(() => release.assertReleasable(Money.of(new Decimal('50000')))).toThrow(OverReleaseError);
  });
});

describe('RetentionRelease.toPostingCommand — the §4.2 template (AC1)', () => {
  it('emits exactly 2 lines: Dr AR / Cr Retention Receivable, balanced, dims + party on both', () => {
    const held = Money.of(new Decimal('100000'));
    const release = RetentionRelease.createDraft('r-1', baseInput({ releasedAmount: '100000' }), held);
    const cmd = release.toPostingCommand(ACCOUNTS, 'u1');

    expect(cmd.lines).toHaveLength(2);
    expect(cmd.voucherType).toBe('JOURNAL'); // interim choice — design §10 / SRS §16
    expect(cmd.sourceType).toBe('RetentionRelease');
    expect(cmd.sourceId).toBe('r-1');
    expect(cmd.voucherDate).toBe('2027-06-29');

    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe('100000.0000');
    expect(cr.toFixed(4)).toBe('100000.0000');
    expect(dr.equals(cr)).toBe(true);

    const arLine = cmd.lines.find((l) => l.accountId === ACCOUNTS.accountsReceivable);
    expect(arLine?.debit.amount.toFixed(4)).toBe('100000.0000');
    expect(arLine?.credit.amount.toFixed(4)).toBe('0.0000');
    expect(arLine?.partyId).toBe(CUSTOMER);
    expect(arLine?.projectId).toBe(PROJECT);
    expect(arLine?.costCentreId).toBe(CC);
    expect(arLine?.purposeId).toBe(PURPOSE);
    expect(arLine?.isControlAccount).toBe(true);

    const retLine = cmd.lines.find((l) => l.accountId === ACCOUNTS.retentionReceivable);
    expect(retLine?.credit.amount.toFixed(4)).toBe('100000.0000');
    expect(retLine?.debit.amount.toFixed(4)).toBe('0.0000');
    expect(retLine?.partyId).toBe(CUSTOMER);
    expect(retLine?.projectId).toBe(PROJECT);
    expect(retLine?.costCentreId).toBe(CC);
    expect(retLine?.purposeId).toBe(PURPOSE);
    expect(retLine?.isControlAccount).toBe(true);

    // No godown on either line (matches SAL's own §4.2 convention).
    for (const l of cmd.lines) expect(l.godownId).toBeUndefined();
  });

  it('balances for a partial release amount too', () => {
    const held = Money.of(new Decimal('100000'));
    const release = RetentionRelease.createDraft('r-1', baseInput({ releasedAmount: '37500.5' }), held);
    const cmd = release.toPostingCommand(ACCOUNTS, 'u1');
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe('37500.5000');
    expect(dr.equals(cr)).toBe(true);
  });
});

describe('RetentionRelease — lifecycle guards', () => {
  it('markPosted only from DRAFT; a second markPosted throws', () => {
    const held = Money.of(new Decimal('100000'));
    const release = RetentionRelease.createDraft('r-1', baseInput(), held);
    release.markPosted('entry-1', 'JV/2526/0001', 'u1', new Date());
    expect(release.props.status).toBe('POSTED');
    expect(release.props.entryNo).toBe('JV/2526/0001');
    expect(() => release.markPosted('entry-2', 'JV/2526/0002', 'u1', new Date())).toThrow(ValidationError);
  });

  it('assertPostable throws once not DRAFT', () => {
    const held = Money.of(new Decimal('100000'));
    const release = RetentionRelease.createDraft('r-1', baseInput(), held);
    release.markPosted('entry-1', 'JV/2526/0001', 'u1', new Date());
    expect(() => release.assertPostable()).toThrow(ValidationError);
  });

  it('rehydrate round-trips props', () => {
    const release = RetentionRelease.rehydrate('r-1', {
      companyId: CO,
      financialYearId: FY,
      ipcId: IPC,
      projectId: PROJECT,
      customerId: CUSTOMER,
      costCentreId: CC,
      purposeId: PURPOSE,
      releaseDate: '2027-06-29',
      releasedAmount: Money.of(new Decimal('50000')),
      narration: null,
      status: 'POSTED',
      entryNo: 'JV/2526/0001',
      journalEntryId: 'entry-1',
      postedAt: new Date('2027-06-29T10:00:00Z'),
      postedBy: 'u1',
      version: 2,
    });
    expect(release.props.status).toBe('POSTED');
    expect(release.version).toBe(2);
  });
});
