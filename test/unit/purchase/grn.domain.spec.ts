/**
 * Grn aggregate unit tests (pure — no DB, no Nest). Cites FR-PUR-015 (received_qty > 0, godown + four
 * dimensions per line), FR-PUR-016 (actual received quantity, may differ from billed), FR-PUR-024
 * (DRAFT-only edit; lifecycle guards), and the §10 Q4 option-(a) shape (a GRN holds NO ledger/stock
 * references — informational). 100% on grn.ts.
 */
import Decimal from 'decimal.js';
import { Grn, NewGrn } from '../../../src/modules/purchase/domain/grn';
import { GrnNotDraftError, GrnNotPostedError } from '../../../src/modules/purchase/domain/errors';
import { ValidationError } from '../../../src/common/errors/domain-error';

const d = (v: string | number) => new Decimal(v);
const AT = new Date('2026-06-29T11:00:00Z');

function input(overrides: Partial<NewGrn> = {}): NewGrn {
  return {
    projectId: 'p-01',
    supplierId: 'supp-x',
    purchaseOrderId: 'po-1',
    purchaseBillId: 'bill-1',
    grnRefNo: 'GRN-2026-0301',
    receiptDate: '2026-06-29',
    narration: '10 bags short',
    lines: [
      {
        purchaseBillLineId: 'bl-1',
        itemId: 'item-cement',
        receivedQty: '90',
        rate: '500',
        godownId: 'g-site-a',
        costCentreId: 'cc-slab',
        purposeId: 'pur-day20',
      },
    ],
    ...overrides,
  };
}

function draft(overrides: Partial<NewGrn> = {}, lineIds = ['gl-1', 'gl-2', 'gl-3']): Grn {
  return Grn.createDraft('grn-1', 'co1', 'fy1', input(overrides), lineIds);
}

describe('Grn.createDraft (FR-PUR-015)', () => {
  it('captures the header + lines; receivedValue = receivedQty x rate, exact Decimal(18,4)', () => {
    const g = draft();
    expect(g.props.status).toBe('DRAFT');
    expect(g.props.companyId).toBe('co1');
    expect(g.props.financialYearId).toBe('fy1');
    expect(g.props.purchaseBillId).toBe('bill-1');
    expect(g.props.purchaseOrderId).toBe('po-1');
    expect(g.props.grnRefNo).toBe('GRN-2026-0301');
    expect(g.props.postedAt).toBeNull();
    expect(g.lines).toHaveLength(1);
    const l = g.lines[0];
    expect(l.receivedQty.toFixed(4)).toBe('90.0000');
    expect(l.receivedValue.toFixed(4)).toBe('45000.0000'); // 90 x 500
    expect(l.matchStatus).toBeNull(); // snapshotted only at post
    expect(l.purchaseBillLineId).toBe('bl-1');
  });

  it('a line projectId defaults to the header project when omitted; an explicit one is kept', () => {
    const g = draft({
      lines: [
        { itemId: 'i1', receivedQty: '1', rate: '10', godownId: 'g1', costCentreId: 'cc', purposeId: 'pp' },
        { itemId: 'i2', receivedQty: '1', rate: '10', godownId: 'g1', projectId: 'p-02', costCentreId: 'cc', purposeId: 'pp' },
      ],
    });
    expect(g.lines[0].projectId).toBe('p-01');
    expect(g.lines[1].projectId).toBe('p-02');
  });

  it('rounds receivedValue half-up to 4dp on fractional quantities', () => {
    const g = draft({
      lines: [{ itemId: 'i1', receivedQty: '0.3333', rate: '0.3333', godownId: 'g1', costCentreId: 'cc', purposeId: 'pp' }],
    });
    expect(g.lines[0].receivedValue.toFixed(4)).toBe('0.1111'); // 0.11108889 -> 0.1111
  });

  it.each([['0'], ['-1']])('rejects receivedQty %s (must be > 0 — FR-PUR-015/-016)', (qty) => {
    expect(() => draft({ lines: [{ ...input().lines[0], receivedQty: qty }] })).toThrow(ValidationError);
  });

  it('rejects a negative rate, a non-numeric quantity, a non-finite quantity, and a missing quantity', () => {
    expect(() => draft({ lines: [{ ...input().lines[0], rate: '-1' }] })).toThrow('rate must be >= 0');
    expect(() => draft({ lines: [{ ...input().lines[0], receivedQty: 'abc' }] })).toThrow('not a valid number');
    expect(() => draft({ lines: [{ ...input().lines[0], receivedQty: Infinity }] })).toThrow('finite');
    expect(() => draft({ lines: [{ ...input().lines[0], receivedQty: '' }] })).toThrow('receivedQty is required');
  });

  it.each([
    ['itemId', { itemId: '' }],
    ['godownId', { godownId: ' ' }],
    ['costCentreId', { costCentreId: '' }],
    ['purposeId', { purposeId: '' }],
  ])('rejects a line missing %s (godown + dimensions required — FR-PUR-015, overview §5.1)', (_f, patch) => {
    expect(() => draft({ lines: [{ ...input().lines[0], ...patch }] })).toThrow(ValidationError);
  });

  it('rejects an empty line set and missing header fields', () => {
    expect(() => draft({ lines: [] })).toThrow('A GRN requires at least one line');
    expect(() => draft({ projectId: '' })).toThrow('projectId is required');
    expect(() => draft({ supplierId: '' })).toThrow('supplierId is required');
    expect(() => draft({ receiptDate: '' })).toThrow('receiptDate is required');
  });

  it('optional header refs default to null', () => {
    const g = draft({ purchaseOrderId: undefined, purchaseBillId: undefined, grnRefNo: undefined, narration: undefined });
    expect(g.props.purchaseOrderId).toBeNull();
    expect(g.props.purchaseBillId).toBeNull();
    expect(g.props.grnRefNo).toBeNull();
    expect(g.props.narration).toBeNull();
  });
});

describe('Grn lifecycle (FR-PUR-024; §10 Q4 option (a))', () => {
  it('markPosted: DRAFT -> POSTED stamps postedBy/postedAt/receivedBy; a second post throws 409', () => {
    const g = draft();
    g.markPosted('u-store', AT);
    expect(g.props.status).toBe('POSTED');
    expect(g.props.postedBy).toBe('u-store');
    expect(g.props.receivedBy).toBe('u-store'); // defaults to the poster (the Store Keeper)
    expect(g.props.postedAt).toBe(AT);
    expect(() => g.markPosted('u2', AT)).toThrow(GrnNotDraftError);
  });

  it('updateDraft edits in place while DRAFT; rejected once POSTED (VOUCHER_POSTED_IMMUTABLE)', () => {
    const g = draft();
    g.updateDraft(
      {
        projectId: 'p-02',
        supplierId: 'supp-y',
        purchaseOrderId: null,
        purchaseBillId: null,
        grnRefNo: 'GRN-2',
        receiptDate: '2026-06-30',
        narration: null,
        lines: [{ itemId: 'i9', receivedQty: '5', rate: '2', godownId: 'g9', costCentreId: 'cc9', purposeId: 'pp9' }],
      },
      ['gl-9'],
    );
    expect(g.props.projectId).toBe('p-02');
    expect(g.props.supplierId).toBe('supp-y');
    expect(g.props.purchaseOrderId).toBeNull();
    expect(g.props.purchaseBillId).toBeNull();
    expect(g.props.grnRefNo).toBe('GRN-2');
    expect(g.props.receiptDate).toBe('2026-06-30');
    expect(g.props.narration).toBeNull();
    expect(g.lines[0].itemId).toBe('i9');
    expect(g.lines[0].projectId).toBe('p-02'); // header default applies to replaced lines

    // A partial patch leaves untouched fields alone; non-null ref patches stick.
    g.updateDraft({ narration: 'note' }, []);
    expect(g.props.narration).toBe('note');
    expect(g.props.grnRefNo).toBe('GRN-2');
    g.updateDraft({ purchaseOrderId: 'po-9', purchaseBillId: 'bill-9' }, []);
    expect(g.props.purchaseOrderId).toBe('po-9');
    expect(g.props.purchaseBillId).toBe('bill-9');

    g.markPosted('u-store', AT);
    expect(() => g.updateDraft({ narration: 'x' }, [])).toThrow(GrnNotDraftError);
    try {
      g.updateDraft({ narration: 'x' }, []);
    } catch (e) {
      expect((e as GrnNotDraftError).code).toBe('VOUCHER_POSTED_IMMUTABLE');
    }
  });

  it('markCancelled: POSTED -> CANCELLED only; from DRAFT/CANCELLED throws VOUCHER_NOT_POSTED', () => {
    const g = draft();
    expect(() => g.markCancelled()).toThrow(GrnNotPostedError);
    g.markPosted('u-store', AT);
    g.markCancelled();
    expect(g.props.status).toBe('CANCELLED');
    expect(() => g.markCancelled()).toThrow(GrnNotPostedError);
  });

  it('assertPostable requires DRAFT + at least one line; assertPosted requires POSTED', () => {
    const g = draft();
    expect(() => g.assertPostable()).not.toThrow();
    expect(() => g.assertPosted()).toThrow(GrnNotPostedError);
    const empty = Grn.rehydrate('grn-2', { ...g.props, status: 'DRAFT' }, []);
    expect(() => empty.assertPostable()).toThrow('at least one line');
    g.markPosted('u', AT);
    expect(() => g.assertPostable()).toThrow(GrnNotDraftError);
    expect(() => g.assertPosted()).not.toThrow();
  });

  it('recordMatchStatus snapshots a line status; an unknown lineNo throws', () => {
    const g = draft();
    g.recordMatchStatus(1, 'UNDER_RECEIVED');
    expect(g.lines[0].matchStatus).toBe('UNDER_RECEIVED');
    expect(() => g.recordMatchStatus(99, 'MATCHED')).toThrow('GRN line 99 not found');
  });
});

describe('Grn.receiptLines — the design §2.3 shape (informational under option (a))', () => {
  it('yields (godownId, itemId, receivedQty, rate, receivedValue) per line — NO caller feeds INV', () => {
    const g = draft();
    expect(g.receiptLines()).toEqual([
      {
        godownId: 'g-site-a',
        itemId: 'item-cement',
        receivedQty: d('90'),
        rate: d('500'),
        receivedValue: d('45000'),
      },
    ]);
  });

  it('rehydrate round-trips props + lines and version', () => {
    const g = draft();
    const re = Grn.rehydrate(g.id, { ...g.props, version: 3 }, [...g.lines]);
    expect(re.version).toBe(3);
    expect(re.lines).toHaveLength(1);
    expect(re.props.receiptDate).toBe('2026-06-29');
  });
});
