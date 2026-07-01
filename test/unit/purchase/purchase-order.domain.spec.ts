/**
 * PUR domain unit tests (no DB, no Nest) — the PurchaseOrder aggregate: a NON-POSTING commitment
 * (FR-PUR-001, -002, -003). Covers: draft creation + line dims, DRAFT-only edit, approve()/cancel() state
 * machine, assertBillable() guard (AC13), openQtyOf for bill/GRN defaulting, applyBilledQty status roll.
 */
import Decimal from 'decimal.js';
import { NewPurchaseOrder, PurchaseOrder } from '../../../src/modules/purchase/domain/purchase-order';
import { InvalidPoTransitionError, PoNotBillableError } from '../../../src/modules/purchase/domain/errors';
import { ValidationError } from '../../../src/common/errors/domain-error';

const CO = 'co1';
const FY = 'fy1';
const PROJECT = 'p-01';
const SUPPLIER = 'supp-x';
const CC = 'cc-slab';
const PURPOSE = 'pur-day20-pour';
const GODOWN = 'g-site-a';

function baseInput(overrides: Partial<NewPurchaseOrder> = {}): NewPurchaseOrder {
  return {
    projectId: PROJECT,
    supplierId: SUPPLIER,
    poRefNo: 'PO-2026-0188',
    poDate: '2026-06-20',
    expectedDeliveryDate: '2026-06-28',
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
    ...overrides,
  };
}

function draft(overrides: Partial<NewPurchaseOrder> = {}, ids: string[] = ['l1']): PurchaseOrder {
  return PurchaseOrder.createDraft('po-1', CO, FY, baseInput(overrides), ids);
}

describe('PurchaseOrder — creation (FR-PUR-001)', () => {
  it('creates a DRAFT PO with line amount + all four dimensions per line', () => {
    const po = draft();
    expect(po.props.status).toBe('DRAFT');
    expect(po.lines).toHaveLength(1);
    expect(po.lines[0].lineAmount.toFixed(4)).toBe('50000.0000');
    expect(po.lines[0].godownId).toBe(GODOWN);
    expect(po.lines[0].billedQty.toFixed(4)).toBe('0.0000');
  });

  it('rejects a PO with zero lines', () => {
    expect(() => draft({ lines: [] })).toThrow(ValidationError);
  });

  it('rejects orderedQty <= 0', () => {
    expect(() =>
      draft({
        lines: [
          {
            itemId: 'i',
            orderedQty: '0',
            rate: '10',
            godownId: GODOWN,
            projectId: PROJECT,
            costCentreId: CC,
            purposeId: PURPOSE,
          },
        ],
      }),
    ).toThrow(ValidationError);
  });
});

describe('PurchaseOrder — lifecycle (FR-PUR-002, AC13)', () => {
  it('approve() moves DRAFT -> APPROVED without writing a ledger line or drawing a number', () => {
    const po = draft();
    po.approve('u1', new Date('2026-06-21T09:00:00Z'));
    expect(po.props.status).toBe('APPROVED');
    expect(po.props.approvedBy).toBe('u1');
    expect(po.props.approvedAt).not.toBeNull();
  });

  it('approve() rejected when not DRAFT', () => {
    const po = draft();
    po.approve('u1', new Date());
    expect(() => po.approve('u1', new Date())).toThrow(InvalidPoTransitionError);
  });

  it('editDraft only while DRAFT', () => {
    const po = draft();
    po.editDraft({ narration: 'urgent' }, []);
    po.approve('u1', new Date());
    expect(() => po.editDraft({ narration: 'x' }, [])).toThrow(InvalidPoTransitionError);
  });

  it('cancel() reachable from DRAFT/APPROVED, not from CLOSED/CANCELLED', () => {
    const po1 = draft();
    po1.cancel();
    expect(po1.props.status).toBe('CANCELLED');

    const po2 = draft();
    po2.approve('u1', new Date());
    po2.cancel();
    expect(po2.props.status).toBe('CANCELLED');

    expect(() => po2.cancel()).toThrow(InvalidPoTransitionError);
  });

  it('assertBillable passes for APPROVED/PARTIALLY_*, rejects DRAFT/CLOSED/CANCELLED (AC13)', () => {
    const po = draft();
    expect(() => po.assertBillable()).toThrow(PoNotBillableError);
    po.approve('u1', new Date());
    expect(() => po.assertBillable()).not.toThrow();
  });
});

describe('PurchaseOrder — open quantity + billed roll (FR-PUR-003, -017)', () => {
  it('openQtyOf = ordered - billed', () => {
    const po = draft();
    po.approve('u1', new Date());
    expect(po.openQtyOf(1).toFixed(4)).toBe('100.0000');
    po.applyBilledQty(1, new Decimal('40'));
    expect(po.openQtyOf(1).toFixed(4)).toBe('60.0000');
  });

  it('applyBilledQty rolls status to PARTIALLY_BILLED then CLOSED once fully billed', () => {
    const po = draft();
    po.approve('u1', new Date());
    po.applyBilledQty(1, new Decimal('40'));
    expect(po.props.status).toBe('PARTIALLY_BILLED');
    po.applyBilledQty(1, new Decimal('60'));
    expect(po.props.status).toBe('CLOSED');
  });

  it('a PO with multiple lines requires ALL lines fully billed before CLOSED', () => {
    const po = draft({
      lines: [
        { itemId: 'a', orderedQty: '10', rate: '5', godownId: GODOWN, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE },
        { itemId: 'b', orderedQty: '20', rate: '5', godownId: GODOWN, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE },
      ],
    }, ['l1', 'l2']);
    po.approve('u1', new Date());
    po.applyBilledQty(1, new Decimal('10'));
    expect(po.props.status).toBe('PARTIALLY_BILLED');
    po.applyBilledQty(2, new Decimal('20'));
    expect(po.props.status).toBe('CLOSED');
  });
});
