/**
 * PAY posting domain unit tests (no DB, no Nest) — buildPaymentCommand's balanced Dr/Cr templates. Covers:
 * §4.1 supplier (Dr AP + Dr BankCharges / Cr Bank, AP party-tagged + LIABILITY not expense, bank-charge
 * dims); §4.2 daily-labour accrued-vs-paid true-up BOTH directions (paid < accrued -> Cr LabourCost;
 * paid > accrued -> Dr LabourCost; labour-payable debit = full accrued); §4.3 salary (Dr SalaryPayable /
 * Cr Bank, LIABILITY not expense); zero-line omission (no charge, no true-up); AC4 the settlement-is-expense
 * guard.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { NewPayment, PaymentVoucher } from '../../../src/modules/payment/domain/payment-voucher';
import { buildPaymentCommand, PaymentAccountMap } from '../../../src/modules/payment/domain/payment-posting';
import { PaymentAllocation, PayableType } from '../../../src/modules/payment/domain/allocation';
import { AccountType } from '../../../src/core/posting/domain/posting-command';
import { SettlementAccountIsExpenseError } from '../../../src/modules/payment/domain/errors';

const CO = 'co1';
const FY = 'fy1';

const ACC = {
  ap: 'acc-ap',
  labourPayable: 'acc-labour-payable',
  salaryPayable: 'acc-salary-payable',
  labourCost: 'acc-labour-cost',
  bankCharges: 'acc-bank-charges',
  bank: 'acc-bank',
};

const accounts: PaymentAccountMap = {
  labourCostAccountId: ACC.labourCost,
  bankChargesAccountId: ACC.bankCharges,
  controlAccountFor: (a: PaymentAllocation) => ({
    accountId: a.controlAccountId as string,
    accountType: a.controlAccountType as AccountType,
    isControlAccount: a.isControlAccount as boolean,
  }),
};

interface Binding {
  controlAccountId: string;
  controlAccountType: AccountType;
  isControlAccount: boolean;
  partyId: string | null;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  accruedAmount: Money | null;
}

function build(
  allocation: { payableType: PayableType; payableId: string; amountAllocated: string },
  binding: Binding,
  extra: Partial<NewPayment> = {},
): PaymentVoucher {
  const p = PaymentVoucher.createDraft('pay-1', CO, FY, {
    paymentDate: '2026-06-30',
    paymentMode: 'BANK_TRANSFER',
    paymentAccountId: ACC.bank,
    chequeTxnRef: 'TXN-1',
    paymentAmount: '100000000',
    allocations: [allocation],
    ...extra,
  });
  p.applyResolvedPayable(1, binding);
  return p;
}

function drcr(cmd: PostingCommand): { dr: string; cr: string } {
  const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
  const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
  return { dr: dr.toFixed(4), cr: cr.toFixed(4) };
}

describe('buildPaymentCommand — §4.1 supplier bill', () => {
  it('Dr AP 200000 (party) + Dr BankCharges 150 (dims) / Cr Bank 200150, balanced, AP is LIABILITY', () => {
    const p = build(
      { payableType: 'PURCHASE_BILL', payableId: 'bill-1', amountAllocated: '200000' },
      {
        controlAccountId: ACC.ap,
        controlAccountType: 'LIABILITY',
        isControlAccount: true,
        partyId: 'supplier-1',
        projectId: null,
        costCentreId: null,
        purposeId: null,
        accruedAmount: null,
      },
      {
        paymentAmount: '200150',
        bankChargesAmount: '150',
        bankChargesProjectId: 'p-1',
        bankChargesCostCentreId: 'cc-1',
        bankChargesPurposeId: 'pur-1',
      },
    );
    const cmd = buildPaymentCommand(p, accounts, 'u1');
    expect(cmd.voucherType).toBe('PAYMENT');
    expect(drcr(cmd)).toEqual({ dr: '200150.0000', cr: '200150.0000' });

    const ap = cmd.lines.find((l) => l.accountId === ACC.ap)!;
    expect(ap.debit.amount.toFixed(4)).toBe('200000.0000');
    expect(ap.accountType).toBe('LIABILITY');
    expect(ap.partyId).toBe('supplier-1');
    expect(ap.isControlAccount).toBe(true);
    expect(ap.projectId).toBeUndefined();
    expect(ap.costCentreId).toBeUndefined();

    const charge = cmd.lines.find((l) => l.accountId === ACC.bankCharges)!;
    expect(charge.debit.amount.toFixed(4)).toBe('150.0000');
    expect(charge.accountType).toBe('EXPENSE');
    expect(charge).toMatchObject({ projectId: 'p-1', costCentreId: 'cc-1', purposeId: 'pur-1' });

    const bank = cmd.lines.find((l) => l.accountId === ACC.bank)!;
    expect(bank.credit.amount.toFixed(4)).toBe('200150.0000');
    expect(bank.partyId).toBeUndefined();
    expect(bank.accountType).toBe('ASSET');
  });
});

describe('buildPaymentCommand — §4.2 daily-labour accrued-vs-paid true-up', () => {
  const labourBinding = (accrued: string): Binding => ({
    controlAccountId: ACC.labourPayable,
    controlAccountType: 'LIABILITY',
    isControlAccount: false,
    partyId: null,
    projectId: 'p-1',
    costCentreId: 'cc-slab',
    purposeId: 'pur-labour',
    accruedAmount: Money.of(new Decimal(accrued)),
  });

  it('paid 49800 < accrued 50000: Dr LabourPayable 50000 / Cr LabourCost 200 / Cr Cash 49800', () => {
    const p = build(
      { payableType: 'LABOUR_PAYABLE', payableId: 'lp-1', amountAllocated: '49800' },
      labourBinding('50000'),
      { paymentAmount: '49800', bankChargesAmount: '0' },
    );
    const cmd = buildPaymentCommand(p, accounts, 'u1');
    expect(drcr(cmd)).toEqual({ dr: '50000.0000', cr: '50000.0000' });

    const lp = cmd.lines.find((l) => l.accountId === ACC.labourPayable)!;
    expect(lp.debit.amount.toFixed(4)).toBe('50000.0000'); // full accrued
    expect(lp.partyId).toBeUndefined();
    expect(lp.isControlAccount).toBe(false);

    const cost = cmd.lines.find((l) => l.accountId === ACC.labourCost)!;
    expect(cost.credit.amount.toFixed(4)).toBe('200.0000'); // cost down
    expect(cost).toMatchObject({ projectId: 'p-1', costCentreId: 'cc-slab', purposeId: 'pur-labour' });

    const cash = cmd.lines.find((l) => l.accountId === ACC.bank)!;
    expect(cash.credit.amount.toFixed(4)).toBe('49800.0000');
  });

  it('paid 50200 > accrued 50000: Dr LabourPayable 50000 + Dr LabourCost 200 / Cr Cash 50200', () => {
    const p = build(
      { payableType: 'LABOUR_PAYABLE', payableId: 'lp-1', amountAllocated: '50200' },
      labourBinding('50000'),
      { paymentAmount: '50200', bankChargesAmount: '0' },
    );
    const cmd = buildPaymentCommand(p, accounts, 'u1');
    expect(drcr(cmd)).toEqual({ dr: '50200.0000', cr: '50200.0000' });

    const lp = cmd.lines.find((l) => l.accountId === ACC.labourPayable)!;
    expect(lp.debit.amount.toFixed(4)).toBe('50000.0000');

    const cost = cmd.lines.find((l) => l.accountId === ACC.labourCost)!;
    expect(cost.debit.amount.toFixed(4)).toBe('200.0000'); // cost up

    const cash = cmd.lines.find((l) => l.accountId === ACC.bank)!;
    expect(cash.credit.amount.toFixed(4)).toBe('50200.0000');
  });

  it('paid == accrued: plain settlement, no true-up line', () => {
    const p = build(
      { payableType: 'LABOUR_PAYABLE', payableId: 'lp-1', amountAllocated: '50000' },
      labourBinding('50000'),
      { paymentAmount: '50000', bankChargesAmount: '0' },
    );
    const cmd = buildPaymentCommand(p, accounts, 'u1');
    expect(cmd.lines).toHaveLength(2);
    expect(cmd.lines.find((l) => l.accountId === ACC.labourCost)).toBeUndefined();
    expect(drcr(cmd)).toEqual({ dr: '50000.0000', cr: '50000.0000' });
  });
});

describe('buildPaymentCommand — §4.3 salary + zero-line omission + AC4', () => {
  it('salary: Dr SalaryPayable 480000 / Cr Bank 480000, LIABILITY not expense, no party', () => {
    const p = build(
      { payableType: 'SALARY', payableId: 'sheet-1', amountAllocated: '480000' },
      {
        controlAccountId: ACC.salaryPayable,
        controlAccountType: 'LIABILITY',
        isControlAccount: false,
        partyId: null,
        projectId: null,
        costCentreId: null,
        purposeId: null,
        accruedAmount: null,
      },
      { paymentAmount: '480000', bankChargesAmount: '0' },
    );
    const cmd = buildPaymentCommand(p, accounts, 'u1');
    expect(cmd.lines).toHaveLength(2);
    expect(drcr(cmd)).toEqual({ dr: '480000.0000', cr: '480000.0000' });
    const sp = cmd.lines.find((l) => l.accountId === ACC.salaryPayable)!;
    expect(sp.debit.amount.toFixed(4)).toBe('480000.0000');
    expect(sp.accountType).toBe('LIABILITY');
    expect(sp.partyId).toBeUndefined();
  });

  it('zero-line omission: no charge, no true-up -> exactly the settlement debit + cash credit', () => {
    const p = build(
      { payableType: 'PURCHASE_BILL', payableId: 'bill-1', amountAllocated: '1000' },
      {
        controlAccountId: ACC.ap,
        controlAccountType: 'LIABILITY',
        isControlAccount: true,
        partyId: 'supplier-1',
        projectId: null,
        costCentreId: null,
        purposeId: null,
        accruedAmount: null,
      },
      { paymentAmount: '1000', bankChargesAmount: '0' },
    );
    const cmd = buildPaymentCommand(p, accounts, 'u1');
    expect(cmd.lines).toHaveLength(2);
    expect(cmd.lines.find((l) => l.accountId === ACC.bankCharges)).toBeUndefined();
  });

  it('AC4: a settlement account classified EXPENSE throws SettlementAccountIsExpenseError', () => {
    const p = build(
      { payableType: 'PURCHASE_BILL', payableId: 'bill-1', amountAllocated: '1000' },
      {
        controlAccountId: 'acc-expense',
        controlAccountType: 'EXPENSE',
        isControlAccount: false,
        partyId: null,
        projectId: null,
        costCentreId: null,
        purposeId: null,
        accruedAmount: null,
      },
      { paymentAmount: '1000', bankChargesAmount: '0' },
    );
    expect(() => buildPaymentCommand(p, accounts, 'u1')).toThrow(SettlementAccountIsExpenseError);
  });
});
