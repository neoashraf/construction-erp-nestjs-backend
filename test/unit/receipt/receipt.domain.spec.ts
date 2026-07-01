/**
 * REC domain unit tests (no DB, no Nest) — the Receipt aggregate money composition + lifecycle +
 * buildReceiptCommand. Cites FR-REC-001/-004/-006/-007/-010/-011/-012/-019/-020/-024. Covers: the §4.1/§4.2
 * worked templates & balancing with dimensions + party (AC1, AC3); zero-tax-line omission; the settled
 * composition invariant incl. zero-cash (AC2); the reference XOR (AC9); the cheque-ref rule (AC9);
 * lifecycle guards (AC11).
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { Receipt, NewReceipt } from '../../../src/modules/receipt/domain/receipt';
import { buildReceiptCommand, ReceiptAccountMap } from '../../../src/modules/receipt/domain/receipt-posting';
import {
  ChequeRefMissingError,
  NotDraftError,
  NotPostedError,
  OverApplicationError,
  ReferenceXorError,
  SettledAmountInvalidError,
} from '../../../src/modules/receipt/domain/errors';
import { ValidationError } from '../../../src/common/errors/domain-error';

const CO = 'co1';
const FY = 'fy1';
const PROJECT = 'p-01';
const CUSTOMER = 'cust-a';
const CC = 'cc-slab';
const PURPOSE = 'pur-ipc-7';
const IPC = 'ipc-7';
const DEPOSIT = 'acc-bank';

const ACCOUNTS: ReceiptAccountMap = {
  accountsReceivable: 'acc-ar',
  taxDeductedAtSourceRecoverable: 'acc-tds',
};

function ipcLinkedInput(overrides: Partial<NewReceipt> = {}): NewReceipt {
  return {
    receiptType: 'IPC_LINKED',
    receiptDate: '2026-06-30',
    paymentMode: 'BANK_TRANSFER',
    depositAccountId: DEPOSIT,
    partyId: CUSTOMER,
    projectId: PROJECT,
    costCentreId: CC,
    purposeId: PURPOSE,
    ipcId: IPC,
    generalTargetAccountId: null,
    amountSettled: '500000',
    taxDeductedAtSource: '25000',
    chequeTxnRef: 'TXN-2026-0099',
    ...overrides,
  };
}

function generalInput(overrides: Partial<NewReceipt> = {}): NewReceipt {
  return {
    receiptType: 'GENERAL',
    receiptDate: '2026-06-30',
    paymentMode: 'CASH',
    depositAccountId: 'acc-cash',
    partyId: CUSTOMER,
    projectId: null,
    costCentreId: 'cc-overheads',
    purposeId: 'pur-scrap',
    ipcId: null,
    generalTargetAccountId: 'acc-income-scrap',
    amountSettled: '30000',
    ...overrides,
  };
}

function draft(input: NewReceipt): Receipt {
  return Receipt.createDraft('rec-1', CO, FY, input);
}

describe('Receipt — settled composition (AC2, FR-REC-019/-020)', () => {
  it('derives cashReceived = amountSettled - taxDeductedAtSource exactly', () => {
    const r = draft(ipcLinkedInput());
    expect(r.props.amountSettled.amount.toFixed(4)).toBe('500000.0000');
    expect(r.props.cashReceived.amount.toFixed(4)).toBe('475000.0000');
    expect(r.props.taxDeductedAtSource.amount.toFixed(4)).toBe('25000.0000');
  });

  it('a zero-cash receipt (tax-deducted = settled) is valid (edge case 6)', () => {
    const r = draft(ipcLinkedInput({ amountSettled: '50000', taxDeductedAtSource: '50000' }));
    expect(r.props.cashReceived.amount.toFixed(4)).toBe('0.0000');
    expect(r.props.taxDeductedAtSource.amount.toFixed(4)).toBe('50000.0000');
  });

  it('rejects amountSettled <= 0', () => {
    expect(() => draft(ipcLinkedInput({ amountSettled: '0', taxDeductedAtSource: '0' }))).toThrow(
      SettledAmountInvalidError,
    );
    expect(() => draft(ipcLinkedInput({ amountSettled: '-100', taxDeductedAtSource: '0' }))).toThrow(
      SettledAmountInvalidError,
    );
  });

  it('rejects taxDeductedAtSource > amountSettled (cashReceived would be negative)', () => {
    expect(() => draft(ipcLinkedInput({ amountSettled: '100', taxDeductedAtSource: '200' }))).toThrow(
      SettledAmountInvalidError,
    );
  });

  it('rejects a negative taxDeductedAtSource', () => {
    expect(() => draft(ipcLinkedInput({ taxDeductedAtSource: '-5' }))).toThrow(ValidationError);
  });
});

describe('Receipt — reference XOR (AC9, FR-REC-001)', () => {
  it('rejects both ipcId and generalTargetAccountId set', () => {
    expect(() => draft(ipcLinkedInput({ generalTargetAccountId: 'acc-income' }))).toThrow(ReferenceXorError);
  });

  it('rejects neither ipcId nor generalTargetAccountId set', () => {
    expect(() => draft(ipcLinkedInput({ ipcId: null }))).toThrow(ReferenceXorError);
  });

  it('rejects receiptType GENERAL with an ipcId (mismatch)', () => {
    expect(() =>
      draft({ ...generalInput(), generalTargetAccountId: null, ipcId: IPC }),
    ).toThrow(ReferenceXorError);
  });
});

describe('Receipt — cheque-ref rule (AC9, FR-REC-004, edge case 14)', () => {
  it('rejects CHEQUE mode with no chequeTxnRef', () => {
    expect(() => draft(ipcLinkedInput({ paymentMode: 'CHEQUE', chequeTxnRef: null }))).toThrow(
      ChequeRefMissingError,
    );
  });

  it('rejects MFS mode with no chequeTxnRef', () => {
    expect(() => draft(ipcLinkedInput({ paymentMode: 'MFS', chequeTxnRef: undefined }))).toThrow(
      ChequeRefMissingError,
    );
  });

  it('CASH needs no reference', () => {
    const r = draft(generalInput({ paymentMode: 'CASH', chequeTxnRef: null }));
    expect(r.props.chequeTxnRef).toBeNull();
  });
});

describe('Receipt — lifecycle guards (AC11, FR-REC-024)', () => {
  it('assertPostable throws when not DRAFT', () => {
    const r = draft(ipcLinkedInput());
    r.markPosted('entry-1', 'RCT/2526/0001', 'u1', new Date());
    expect(() => r.assertPostable()).toThrow(NotDraftError);
  });

  it('markPosted only from DRAFT', () => {
    const r = draft(ipcLinkedInput());
    r.markPosted('entry-1', 'RCT/2526/0001', 'u1', new Date());
    expect(() => r.markPosted('entry-2', 'RCT/2526/0002', 'u1', new Date())).toThrow(NotDraftError);
  });

  it('markCancelled only from POSTED', () => {
    const r = draft(ipcLinkedInput());
    expect(() => r.markCancelled()).toThrow(NotPostedError);
  });

  it('updateDraft throws once POSTED', () => {
    const r = draft(ipcLinkedInput());
    r.markPosted('entry-1', 'RCT/2526/0001', 'u1', new Date());
    expect(() => r.updateDraft({ amountSettled: '1' })).toThrow(NotDraftError);
  });
});

describe('Receipt — assertWithinOutstanding (AC4, FR-REC-017)', () => {
  it('rejects a settled amount exceeding the IPC outstanding', () => {
    const r = draft(ipcLinkedInput({ amountSettled: '300000', taxDeductedAtSource: '0' }));
    expect(() => r.assertWithinOutstanding(Money.of(new Decimal('275000')))).toThrow(OverApplicationError);
  });

  it('accepts a settled amount within the IPC outstanding', () => {
    const r = draft(ipcLinkedInput({ amountSettled: '275000', taxDeductedAtSource: '0' }));
    expect(() => r.assertWithinOutstanding(Money.of(new Decimal('275000')))).not.toThrow();
  });
});

describe('buildReceiptCommand — §4.1 IPC-linked template (AC1, FR-REC-010, FR-REC-006)', () => {
  it('produces Dr deposit + Dr tax-recoverable / Cr AR, balanced at 500,000, dims + party', () => {
    const r = draft(ipcLinkedInput());
    const cmd = buildReceiptCommand(r, ACCOUNTS, 'u1');

    expect(cmd.voucherType).toBe('RECEIPT');
    expect(cmd.lines).toHaveLength(3);

    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe('500000.0000');
    expect(cr.toFixed(4)).toBe('500000.0000');

    const deposit = cmd.lines.find((l) => l.accountId === DEPOSIT)!;
    expect(deposit.debit.amount.toFixed(4)).toBe('475000.0000');
    expect(deposit.partyId).toBeUndefined();
    expect(deposit).toMatchObject({ projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE });
    expect(deposit.godownId).toBeUndefined();

    const tds = cmd.lines.find((l) => l.accountId === ACCOUNTS.taxDeductedAtSourceRecoverable)!;
    expect(tds.debit.amount.toFixed(4)).toBe('25000.0000');
    expect(tds.partyId).toBeUndefined();

    const ar = cmd.lines.find((l) => l.accountId === ACCOUNTS.accountsReceivable)!;
    expect(ar.credit.amount.toFixed(4)).toBe('500000.0000');
    expect(ar.partyId).toBe(CUSTOMER);
    expect(ar.isControlAccount).toBe(true);
  });

  it('omits the zero-tax line when taxDeductedAtSource = 0 (edge case 3)', () => {
    const r = draft(ipcLinkedInput({ amountSettled: '500000', taxDeductedAtSource: '0' }));
    const cmd = buildReceiptCommand(r, ACCOUNTS, 'u1');
    expect(cmd.lines).toHaveLength(2);
    expect(cmd.lines.find((l) => l.accountId === ACCOUNTS.taxDeductedAtSourceRecoverable)).toBeUndefined();
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe(cr.toFixed(4));
    expect(dr.toFixed(4)).toBe('500000.0000');
  });

  it('omits the zero-cash deposit line when cashReceived = 0 (edge case 6)', () => {
    const r = draft(ipcLinkedInput({ amountSettled: '50000', taxDeductedAtSource: '50000' }));
    const cmd = buildReceiptCommand(r, ACCOUNTS, 'u1');
    expect(cmd.lines.find((l) => l.accountId === DEPOSIT)).toBeUndefined();
    expect(cmd.lines).toHaveLength(2);
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe(cr.toFixed(4));
    expect(dr.toFixed(4)).toBe('50000.0000');
  });
});

describe('buildReceiptCommand — §4.2 general template (AC3, FR-REC-011, FR-REC-007)', () => {
  it('produces Dr Cash / Cr Income, project null, no party, balanced', () => {
    const r = draft(generalInput());
    const cmd = buildReceiptCommand(r, ACCOUNTS, 'u1', { isControlAccount: false, accountType: 'INCOME' });

    expect(cmd.lines).toHaveLength(2);
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe(cr.toFixed(4));
    expect(dr.toFixed(4)).toBe('30000.0000');

    const income = cmd.lines.find((l) => l.accountId === 'acc-income-scrap')!;
    expect(income.projectId).toBeUndefined();
    expect(income.costCentreId).toBe('cc-overheads');
    expect(income.purposeId).toBe('pur-scrap');
    expect(income.partyId).toBeUndefined();
    expect(income.isControlAccount).toBe(false);
  });

  it('the mobilization-advance variant credits a party-tagged liability, balanced', () => {
    const r = draft(
      generalInput({
        projectId: PROJECT,
        costCentreId: 'cc-overheads',
        purposeId: 'pur-mobilization',
        generalTargetAccountId: 'acc-advance-liability',
        amountSettled: '1000000',
        paymentMode: 'BANK_TRANSFER',
        chequeTxnRef: 'TXN-ADV-001',
      }),
    );
    const cmd = buildReceiptCommand(r, ACCOUNTS, 'u1', { isControlAccount: true, accountType: 'LIABILITY' });

    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe(cr.toFixed(4));
    expect(dr.toFixed(4)).toBe('1000000.0000');

    const liability = cmd.lines.find((l) => l.accountId === 'acc-advance-liability')!;
    expect(liability.partyId).toBe(CUSTOMER);
    expect(liability.projectId).toBe(PROJECT);
    expect(liability.isControlAccount).toBe(true);
  });
});
