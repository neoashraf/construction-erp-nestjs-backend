/**
 * InventoryService (brief 3) unit tests — the port over a fake StockMovementRepository (mirrors
 * `test/unit/inventory/stock-journal-use-cases.spec.ts`'s fake-repo pattern). Cites FR-INV-002/-003/-006/
 * -010/-014. Covers: `receiveIn` rolls the average via the SAME `applyReceipt` the Stock Journal uses and
 * writes an `IN`/`GRN`-sourced movement; `issueOut` values via the SAME `valueIssue`, writes an
 * `OUT`/`REQ_ISSUE`-sourced movement, and blocks/authorises negative stock; both enrol in the caller's
 * transaction (no `uow.run` of their own — the fake repo has no transaction concept, proving the adapter
 * never opens one); the shared lock (`currentBalanceForUpdate`) is the same call a Stock Journal post uses.
 */
import Decimal from 'decimal.js';
import { InventoryServiceAdapter } from '../../../src/modules/inventory/application/inventory.service';
import { NegativeStockError } from '../../../src/modules/inventory/domain/errors';
import { applyReceipt, valueIssue } from '../../../src/modules/inventory/domain/valuation';

const CLOCK = { now: () => new Date('2026-07-05T00:00:00Z') };
function makeIds() {
  let n = 0;
  return { next: () => `mv-${++n}` };
}

/** A fake StockMovementRepository — a single (godown,item) balance keyed by `${godownId}:${itemId}`. */
function fakeMovements(initial: Record<string, { qty: string; value: string }> = {}) {
  const balances = new Map(
    Object.entries(initial).map(([k, v]) => [k, { qty: new Decimal(v.qty), value: new Decimal(v.value) }]),
  );
  const appended: Array<Record<string, unknown>> = [];
  return {
    appended,
    append: jest.fn(async (m: { props: Record<string, unknown> }) => {
      appended.push(m.props);
      const key = `${m.props.godownId}:${m.props.itemId}`;
      balances.set(key, { qty: m.props.balanceQtyAfter as Decimal, value: m.props.balanceValueAfter as Decimal });
    }),
    currentBalanceForUpdate: jest.fn(async (_companyId: string, godownId: string, itemId: string) => {
      return balances.get(`${godownId}:${itemId}`) ?? { qty: new Decimal(0), value: new Decimal(0) };
    }),
    balanceAsOf: jest.fn(),
  };
}

const CTX = { companyId: 'co1', voucherDate: '2026-07-05', postedBy: 'u1' };

describe('InventoryServiceAdapter (the PUR/REQ seam)', () => {
  it('receiveIn rolls the average via the same applyReceipt the Stock Journal uses, writes an IN/GRN movement (FR-INV-002/-006)', async () => {
    const movements = fakeMovements({ 'g-a:item-cement': { qty: '100', value: '50000' } });
    const svc = new InventoryServiceAdapter(movements as never, makeIds(), CLOCK);

    const expected = applyReceipt({ qty: new Decimal('100'), value: new Decimal('50000') }, new Decimal('50'), new Decimal('520'));
    const res = await svc.receiveIn(CTX, {
      godownId: 'g-a',
      itemId: 'item-cement',
      qty: new Decimal('50'),
      rate: new Decimal('520'),
      sourceId: 'grn-1',
    });

    expect(res.avgRate?.toFixed(4)).toBe(expected.value.dividedBy(expected.qty).toFixed(4));
    expect(movements.append).toHaveBeenCalledTimes(1);
    const [m] = movements.appended;
    expect(m.direction).toBe('IN');
    expect(m.sourceType).toBe('GRN');
    expect(m.sourceId).toBe('grn-1');
    expect((m.quantity as Decimal).toFixed(4)).toBe('50.0000');
    expect((m.value as Decimal).toFixed(4)).toBe('26000.0000');
    expect((m.balanceQtyAfter as Decimal).toFixed(4)).toBe('150.0000');
  });

  it('receiveIn creates no StockJournal voucher — writes only the movement (FR-INV-006)', async () => {
    const movements = fakeMovements();
    const svc = new InventoryServiceAdapter(movements as never, makeIds(), CLOCK);
    await svc.receiveIn(CTX, {
      godownId: 'g-a',
      itemId: 'item-cement',
      qty: new Decimal('100'),
      rate: new Decimal('500'),
      sourceId: 'grn-1',
    });
    // no stock-journal-shaped surface exists on the adapter at all — receiveIn/issueOut is the whole API
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(svc));
    expect(surface).toEqual(expect.arrayContaining(['receiveIn', 'issueOut']));
    expect(surface.some((n) => /stockJournal|voucher/i.test(n))).toBe(false);
  });

  it('issueOut values via the same valueIssue, writes an OUT/REQ_ISSUE movement, returns {issuedValue, rate} (FR-INV-003)', async () => {
    const movements = fakeMovements({ 'g-a:item-cement': { qty: '150', value: '76000' } });
    const svc = new InventoryServiceAdapter(movements as never, makeIds(), CLOCK);

    const expected = valueIssue({ qty: new Decimal('150'), value: new Decimal('76000') }, new Decimal('40'), { allowNegative: false });
    const res = await svc.issueOut(CTX, {
      godownId: 'g-a',
      itemId: 'item-cement',
      qty: new Decimal('40'),
      allowNegative: false,
      sourceId: 'req-issue-1',
    });

    expect(res.issuedValue.toFixed(4)).toBe(expected.issuedValue.toFixed(4));
    expect(res.rate.toFixed(4)).toBe(expected.rate.toFixed(4));
    const [m] = movements.appended;
    expect(m.direction).toBe('OUT');
    expect(m.sourceType).toBe('REQ_ISSUE');
    expect(m.sourceId).toBe('req-issue-1');
    expect((m.value as Decimal).toFixed(4)).toBe(expected.issuedValue.toFixed(4));
  });

  it('issueOut blocks negative stock unless authorised (FR-INV-014/-015)', async () => {
    const movements = fakeMovements({ 'g-a:item-cement': { qty: '10', value: '5200' } });
    const svc = new InventoryServiceAdapter(movements as never, makeIds(), CLOCK);

    await expect(
      svc.issueOut(CTX, { godownId: 'g-a', itemId: 'item-cement', qty: new Decimal('50'), allowNegative: false, sourceId: 'req-issue-2' }),
    ).rejects.toThrow(NegativeStockError);
    expect(movements.append).not.toHaveBeenCalled();

    const res = await svc.issueOut(CTX, {
      godownId: 'g-a',
      itemId: 'item-cement',
      qty: new Decimal('50'),
      allowNegative: true,
      sourceId: 'req-issue-2',
    });
    expect(res.issuedValue.isPositive() || res.issuedValue.isZero()).toBe(true);
    expect(movements.append).toHaveBeenCalledTimes(1);
  });

  it('shares the locked re-roll: both methods read the balance via currentBalanceForUpdate (FR-INV-010, design §5.4)', async () => {
    const movements = fakeMovements({ 'g-a:item-cement': { qty: '100', value: '50000' } });
    const svc = new InventoryServiceAdapter(movements as never, makeIds(), CLOCK);
    await svc.receiveIn(CTX, { godownId: 'g-a', itemId: 'item-cement', qty: new Decimal('10'), rate: new Decimal('500'), sourceId: 'grn-2' });
    await svc.issueOut(CTX, { godownId: 'g-a', itemId: 'item-cement', qty: new Decimal('5'), allowNegative: false, sourceId: 'req-issue-3' });
    expect(movements.currentBalanceForUpdate).toHaveBeenCalledTimes(2);
    expect(movements.currentBalanceForUpdate).toHaveBeenNthCalledWith(1, 'co1', 'g-a', 'item-cement');
    expect(movements.currentBalanceForUpdate).toHaveBeenNthCalledWith(2, 'co1', 'g-a', 'item-cement');
  });

  it('opens no transaction of its own — a fake repo with no UoW concept still works (the caller owns the tx)', async () => {
    // No UnitOfWork is passed into the constructor at all; the adapter has nowhere to open one.
    const movements = fakeMovements();
    const svc = new InventoryServiceAdapter(movements as never, makeIds(), CLOCK);
    await expect(
      svc.receiveIn(CTX, { godownId: 'g-a', itemId: 'item-cement', qty: new Decimal('1'), rate: new Decimal('1'), sourceId: 'grn-3' }),
    ).resolves.toBeDefined();
  });
});
