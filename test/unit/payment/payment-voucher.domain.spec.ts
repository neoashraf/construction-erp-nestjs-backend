/**
 * PAY domain unit tests (no DB, no Nest) — the PaymentVoucher aggregate composition + lifecycle. Covers:
 * createDraft invariants (over-allocation, cheque-ref, charge-tags, each allocation > 0) and the DRAFT/
 * POSTED lifecycle guards.
 */
import { NewPayment, PaymentVoucher } from '../../../src/modules/payment/domain/payment-voucher';
import {
  ChequeRefMissingError,
  NotDraftError,
  NotPostedError,
  OverAllocationError,
} from '../../../src/modules/payment/domain/errors';
import { ValidationError } from '../../../src/common/errors/domain-error';

const CO = 'co1';
const FY = 'fy1';

function input(overrides: Partial<NewPayment> = {}): NewPayment {
  return {
    paymentDate: '2026-06-30',
    paymentMode: 'BANK_TRANSFER',
    paymentAccountId: 'acc-bank',
    chequeTxnRef: 'TXN-1',
    paymentAmount: '200150',
    allocations: [{ payableType: 'PURCHASE_BILL', payableId: 'bill-1', amountAllocated: '200000' }],
    bankChargesAmount: '150',
    bankChargesProjectId: 'p-1',
    bankChargesCostCentreId: 'cc-1',
    bankChargesPurposeId: 'pur-1',
    ...overrides,
  };
}

function draft(overrides: Partial<NewPayment> = {}): PaymentVoucher {
  return PaymentVoucher.createDraft('pay-1', CO, FY, input(overrides));
}

describe('PaymentVoucher — createDraft invariants', () => {
  it('builds a DRAFT with allocations numbered 1..n', () => {
    const p = draft({
      allocations: [
        { payableType: 'PURCHASE_BILL', payableId: 'b1', amountAllocated: '100' },
        { payableType: 'SALARY', payableId: 's1', amountAllocated: '100' },
      ],
      paymentAmount: '400',
    });
    expect(p.props.status).toBe('DRAFT');
    expect(p.props.allocations.map((a) => a.lineNo)).toEqual([1, 2]);
    expect(p.props.entryNo).toBeNull();
  });

  it('rejects over-allocation (Σ amountAllocated > paymentAmount)', () => {
    expect(() =>
      draft({ paymentAmount: '100', bankChargesAmount: '0', allocations: [{ payableType: 'SALARY', payableId: 's', amountAllocated: '150' }] }),
    ).toThrow(OverAllocationError);
  });

  it('rejects a non-cash mode with no cheque/txn ref', () => {
    expect(() => draft({ paymentMode: 'CHEQUE', chequeTxnRef: null })).toThrow(ChequeRefMissingError);
    expect(() => draft({ paymentMode: 'RTGS', chequeTxnRef: undefined })).toThrow(ChequeRefMissingError);
  });

  it('CASH needs no reference', () => {
    const p = draft({ paymentMode: 'CASH', chequeTxnRef: null });
    expect(p.props.chequeTxnRef).toBeNull();
  });

  it('rejects a bank charge > 0 missing any dimension tag', () => {
    expect(() => draft({ bankChargesPurposeId: null })).toThrow(ValidationError);
    expect(() => draft({ bankChargesProjectId: null })).toThrow(ValidationError);
    expect(() => draft({ bankChargesCostCentreId: null })).toThrow(ValidationError);
  });

  it('a zero bank charge needs no tags', () => {
    const p = draft({ bankChargesAmount: '0', bankChargesProjectId: null, bankChargesCostCentreId: null, bankChargesPurposeId: null, paymentAmount: '200000' });
    expect(p.props.bankChargesAmount.amount.toFixed(4)).toBe('0.0000');
  });

  it('rejects an allocation amount <= 0', () => {
    expect(() => draft({ allocations: [{ payableType: 'SALARY', payableId: 's', amountAllocated: '0' }] })).toThrow(ValidationError);
    expect(() => draft({ allocations: [{ payableType: 'SALARY', payableId: 's', amountAllocated: '-5' }] })).toThrow(ValidationError);
  });
});

describe('PaymentVoucher — lifecycle guards', () => {
  it('assertPostable throws when not DRAFT', () => {
    const p = draft();
    p.markPosted('e1', 'PV/2526/0001', 'u1', new Date());
    expect(() => p.assertPostable()).toThrow(NotDraftError);
  });

  it('assertPostable requires at least one allocation', () => {
    const p = draft({ allocations: [], paymentAmount: '0', bankChargesAmount: '0' });
    expect(() => p.assertPostable()).toThrow(ValidationError);
  });

  it('markPosted only from DRAFT', () => {
    const p = draft();
    p.markPosted('e1', 'PV/2526/0001', 'u1', new Date());
    expect(() => p.markPosted('e2', 'PV/2526/0002', 'u1', new Date())).toThrow(NotDraftError);
  });

  it('markCancelled only from POSTED', () => {
    const p = draft();
    expect(() => p.markCancelled()).toThrow(NotPostedError);
  });

  it('updateDraft throws once POSTED', () => {
    const p = draft();
    p.markPosted('e1', 'PV/2526/0001', 'u1', new Date());
    expect(() => p.updateDraft({ paymentAmount: '1' })).toThrow(NotDraftError);
  });

  it('assertCancellable/assertPosted throw when DRAFT', () => {
    const p = draft();
    expect(() => p.assertCancellable()).toThrow(NotPostedError);
    expect(() => p.assertPosted()).toThrow(NotPostedError);
  });
});
