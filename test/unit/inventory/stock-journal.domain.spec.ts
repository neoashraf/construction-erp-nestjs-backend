/**
 * StockJournal aggregate domain unit tests (PURE, no DB, no Nest). Mirrors
 * `test/unit/inventory/stock-movement.domain.spec.ts`'s style. Asserts mode/side rules (FR-INV-008,
 * edge 2) and the DRAFT → APPROVED → POSTED → CANCELLED lifecycle guards (FR-INV-012/-020/-022,
 * edges 3/4).
 */
import Decimal from 'decimal.js';
import {
  NewStockJournal,
  StockJournal,
} from '../../../src/modules/inventory/domain/stock-journal';
import {
  IssueSideOnTransferOnlyError,
  InvalidStockJournalTransitionError,
  NotApprovedError,
  SameGodownTransferError,
  StockJournalPostedImmutableError,
} from '../../../src/modules/inventory/domain/errors';
import { ValidationError } from '../../../src/common/errors/domain-error';

const base: NewStockJournal = {
  voucherDate: '2026-06-20',
  mode: 'ISSUE',
  fromGodownId: 'g-site-a',
  toGodownId: null,
  itemId: 'item-cement',
  quantity: '50',
  projectId: 'p-01',
  costCentreId: 'cc-slab',
  purposeId: 'pur-day20',
};

describe('StockJournal aggregate — mode/side rules (FR-INV-008, edge 2)', () => {
  it('createDraft(ISSUE) builds a single OUT line, no to-godown', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', base);
    expect(sj.props.status).toBe('DRAFT');
    expect(sj.props.mode).toBe('ISSUE');
    expect(sj.props.fromGodownId).toBe('g-site-a');
    expect(sj.props.toGodownId).toBeNull();
    const lines = sj.toLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].props.side).toBe('OUT');
    expect(lines[0].props.quantity.toString()).toBe('50');
  });

  it('createDraft(ISSUE) rejects a toGodownId (only TRANSFER has a to-side)', () => {
    expect(() =>
      StockJournal.createDraft('sj1', 'co1', 'fy1', { ...base, toGodownId: 'g-site-b' }),
    ).toThrow(IssueSideOnTransferOnlyError);
  });

  it('createDraft(TRANSFER) requires both godowns and builds OUT + IN lines', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', {
      ...base,
      mode: 'TRANSFER',
      toGodownId: 'g-site-b',
    });
    const lines = sj.toLines();
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.props.side)).toEqual(['OUT', 'IN']);
    expect(lines[0].props.godownId).toBe('g-site-a');
    expect(lines[1].props.godownId).toBe('g-site-b');
  });

  it('createDraft(TRANSFER) rejects from === to (SameGodownTransferError, edge 2)', () => {
    expect(() =>
      StockJournal.createDraft('sj1', 'co1', 'fy1', {
        ...base,
        mode: 'TRANSFER',
        toGodownId: 'g-site-a',
      }),
    ).toThrow(SameGodownTransferError);
  });

  it('createDraft(TRANSFER) without a toGodownId is rejected', () => {
    expect(() =>
      StockJournal.createDraft('sj1', 'co1', 'fy1', { ...base, mode: 'TRANSFER' }),
    ).toThrow(ValidationError);
  });

  it('createDraft(ADJUSTMENT) accepts a single from-side only', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', { ...base, mode: 'ADJUSTMENT' });
    expect(sj.toLines()).toHaveLength(1);
    expect(sj.toLines()[0].props.side).toBe('OUT');
  });

  it('createDraft(ADJUSTMENT) accepts a single to-side only', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', {
      ...base,
      mode: 'ADJUSTMENT',
      fromGodownId: null,
      toGodownId: 'g-site-b',
    });
    expect(sj.toLines()).toHaveLength(1);
    expect(sj.toLines()[0].props.side).toBe('IN');
  });

  it('createDraft(ADJUSTMENT) rejects both sides present or neither', () => {
    expect(() =>
      StockJournal.createDraft('sj1', 'co1', 'fy1', { ...base, mode: 'ADJUSTMENT', fromGodownId: null }),
    ).toThrow(ValidationError);
  });

  it('rejects quantity <= 0', () => {
    expect(() => StockJournal.createDraft('sj1', 'co1', 'fy1', { ...base, quantity: '0' })).toThrow(
      ValidationError,
    );
    expect(() => StockJournal.createDraft('sj1', 'co1', 'fy1', { ...base, quantity: '-5' })).toThrow(
      ValidationError,
    );
  });

  it('accepts a Decimal quantity input, exact (no float)', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', { ...base, quantity: new Decimal('12.3456') });
    expect(sj.props.quantity.toFixed(4)).toBe('12.3456');
  });
});

describe('StockJournal aggregate — lifecycle (FR-INV-012/-020/-022, edges 3/4)', () => {
  it('approve(): DRAFT → APPROVED, records approvedById/approvedAt', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', base);
    const now = new Date('2026-06-20T09:12:00Z');
    sj.approve('pm1', now);
    expect(sj.props.status).toBe('APPROVED');
    expect(sj.props.approvedById).toBe('pm1');
    expect(sj.props.approvedAt).toBe(now);
  });

  it('approve() twice is rejected (InvalidStockJournalTransitionError)', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', base);
    sj.approve('pm1', new Date());
    expect(() => sj.approve('pm1', new Date())).toThrow(InvalidStockJournalTransitionError);
  });

  it('assertPostable() throws NotApprovedError unless APPROVED (edge 3)', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', base);
    expect(() => sj.assertPostable()).toThrow(NotApprovedError);
    sj.approve('pm1', new Date());
    expect(() => sj.assertPostable()).not.toThrow();
  });

  it('markPosted(): APPROVED → POSTED, stamps entryNo/journalEntryId/rate/value/lines', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', base);
    sj.approve('pm1', new Date());
    const postedLines = sj.toLines().map((l) => l.withValuation(new Decimal('520'), new Decimal('26000')));
    sj.markPosted('SJ/2526/0001', 'entry-1', new Decimal('520'), new Decimal('26000'), postedLines, 'sk1', new Date());
    expect(sj.props.status).toBe('POSTED');
    expect(sj.props.entryNo).toBe('SJ/2526/0001');
    expect(sj.props.journalEntryId).toBe('entry-1');
    expect(sj.props.value!.toFixed(4)).toBe('26000.0000');
  });

  it('markPosted() with null entryNo/journalEntryId (value-neutral same-account transfer, §4.2)', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', {
      ...base,
      mode: 'TRANSFER',
      toGodownId: 'g-site-b',
    });
    sj.approve('pm1', new Date());
    sj.markPosted(null, null, new Decimal('520'), new Decimal('15600'), sj.toLines(), 'sk1', new Date());
    expect(sj.props.entryNo).toBeNull();
    expect(sj.props.journalEntryId).toBeNull();
    expect(sj.props.status).toBe('POSTED');
  });

  it('editDraft() after POSTED is rejected (edge 4, FR-INV-020)', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', base);
    sj.approve('pm1', new Date());
    sj.markPosted('SJ/1', 'e1', new Decimal('1'), new Decimal('1'), sj.toLines(), 'sk1', new Date());
    expect(() => sj.editDraft({ narration: 'edit' })).toThrow(InvalidStockJournalTransitionError);
    expect(() => sj.assertEditable()).toThrow(StockJournalPostedImmutableError);
  });

  it('editDraft() while DRAFT rebuilds the lines from the merged patch', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', base);
    sj.editDraft({ quantity: '75' });
    expect(sj.props.quantity.toString()).toBe('75');
    expect(sj.toLines()[0].props.quantity.toString()).toBe('75');
  });

  it('markCancelled(): POSTED → CANCELLED; not-POSTED is rejected', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', base);
    expect(() => sj.markCancelled()).toThrow(InvalidStockJournalTransitionError);
    sj.approve('pm1', new Date());
    sj.markPosted('SJ/1', 'e1', new Decimal('1'), new Decimal('1'), sj.toLines(), 'sk1', new Date());
    sj.markCancelled();
    expect(sj.props.status).toBe('CANCELLED');
  });

  it('assertPosted() rejects a re-reverse of an already-CANCELLED journal', () => {
    const sj = StockJournal.createDraft('sj1', 'co1', 'fy1', base);
    sj.approve('pm1', new Date());
    sj.markPosted('SJ/1', 'e1', new Decimal('1'), new Decimal('1'), sj.toLines(), 'sk1', new Date());
    sj.markCancelled();
    expect(() => sj.assertPosted()).toThrow();
  });
});
