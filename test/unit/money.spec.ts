import Decimal from 'decimal.js';
import { Money } from '../../src/common/money';

describe('Money (exact decimal arithmetic)', () => {
  it('adds without floating-point error (0.1 + 0.2 === 0.3)', () => {
    const sum = Money.of('0.1').plus(Money.of('0.2'));
    // The classic float trap: 0.1 + 0.2 = 0.30000000000000004 with `number`. Money must be exact.
    expect(sum.equals(Money.of('0.3'))).toBe(true);
    expect(sum.toFixed()).toBe('0.3000');
  });

  it('subtracts exactly', () => {
    expect(Money.of('100.0000').minus(Money.of('0.3300')).toFixed()).toBe('99.6700');
  });

  it('multiplies exactly (retention 10% of 1,250,000.55)', () => {
    const retention = Money.of('1250000.55').times('0.10');
    expect(retention.toFixed()).toBe('125000.0550');
  });

  it('rounds half-up to the money scale (4 dp)', () => {
    expect(Money.of('1.00005').round().toFixed()).toBe('1.0001');
    expect(Money.of('1.00004').round().toFixed()).toBe('1.0000');
  });

  it('stores the underlying value as a Decimal, never a number', () => {
    expect(Money.of('12.3456').amount).toBeInstanceOf(Decimal);
  });

  it('treats zero consistently', () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.of('0.0000').equals(Money.zero())).toBe(true);
  });

  it('rejects arithmetic across currencies', () => {
    const bdt = Money.of('10', 'BDT');
    const other = Money.of('10', 'USD' as 'BDT');
    expect(() => bdt.plus(other)).toThrow(/currency mismatch/);
  });

  it('balances a set of debits and credits exactly (ledger invariant shape)', () => {
    const debits = [Money.of('700.2500'), Money.of('299.7500')].reduce((a, b) => a.plus(b));
    const credits = [Money.of('1000.0000')].reduce((a, b) => a.plus(b));
    expect(debits.equals(credits)).toBe(true);
  });
});
