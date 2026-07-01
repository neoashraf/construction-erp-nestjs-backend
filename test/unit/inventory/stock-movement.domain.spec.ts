/**
 * StockMovement domain unit tests (PURE). Asserts the append-only fact's invariants: quantity > 0
 * (sign lives in `direction`), value >= 0, the avg_rate_after snapshot, and the signed effect helpers.
 * Cites FR-INV-004 (projection snapshot), FR-INV-020 (append-only fact).
 */
import Decimal from 'decimal.js';
import { StockMovement } from '../../../src/modules/inventory/domain/stock-movement';

const base = {
  companyId: 'c1',
  godownId: 'g1',
  itemId: 'i1',
  sourceType: 'STOCK_JOURNAL' as const,
  sourceId: 's1',
  voucherDate: '2026-06-20',
  postedBy: 'u1',
};

describe('StockMovement (FR-INV-004/-020)', () => {
  it('creates an IN movement with the avg_rate_after snapshot from the balance', () => {
    const m = StockMovement.create(
      {
        ...base,
        direction: 'IN',
        quantity: new Decimal('50'),
        rate: new Decimal('520'),
        value: new Decimal('26000'),
        balanceAfter: { qty: new Decimal('50'), value: new Decimal('26000') },
      },
      'm1',
      new Date('2026-06-20T09:15:00Z'),
    );
    expect(m.props.direction).toBe('IN');
    expect(m.props.avgRateAfter!.toFixed(4)).toBe('520.0000');
    expect(m.signedQuantity().toString()).toBe('50');
    expect(m.signedValue().toFixed(4)).toBe('26000.0000');
  });

  it('an OUT movement subtracts (signed effect is negative)', () => {
    const m = StockMovement.create(
      {
        ...base,
        direction: 'OUT',
        quantity: new Decimal('50'),
        rate: new Decimal('520'),
        value: new Decimal('26000'),
        balanceAfter: { qty: new Decimal('70'), value: new Decimal('36400') },
      },
      'm2',
      new Date(),
    );
    expect(m.signedQuantity().toString()).toBe('-50');
    expect(m.signedValue().toFixed(4)).toBe('-26000.0000');
    expect(m.props.avgRateAfter!.toFixed(4)).toBe('520.0000');
  });

  it('avg_rate_after is null when the balance is zeroed', () => {
    const m = StockMovement.create(
      {
        ...base,
        direction: 'OUT',
        quantity: new Decimal('50'),
        rate: new Decimal('520'),
        value: new Decimal('26000'),
        balanceAfter: { qty: new Decimal('0'), value: new Decimal('0') },
      },
      'm3',
      new Date(),
    );
    expect(m.props.avgRateAfter).toBeNull();
  });

  it('rejects a non-positive quantity — the sign belongs to direction, never the quantity', () => {
    expect(() =>
      StockMovement.create(
        {
          ...base,
          direction: 'IN',
          quantity: new Decimal('0'),
          rate: new Decimal('1'),
          value: new Decimal('0'),
          balanceAfter: { qty: new Decimal('0'), value: new Decimal('0') },
        },
        'm4',
        new Date(),
      ),
    ).toThrow(RangeError);
  });

  it('rejects a negative value', () => {
    expect(() =>
      StockMovement.create(
        {
          ...base,
          direction: 'IN',
          quantity: new Decimal('1'),
          rate: new Decimal('1'),
          value: new Decimal('-1'),
          balanceAfter: { qty: new Decimal('1'), value: new Decimal('-1') },
        },
        'm5',
        new Date(),
      ),
    ).toThrow(RangeError);
  });
});
