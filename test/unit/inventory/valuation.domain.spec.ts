/**
 * INV valuation domain unit tests (PURE — no DB, no Nest). The weighted-average is the single
 * definition of how stock is valued; these assert it exactly with decimal.js (no float drift).
 * Cites FR-INV-002 (receipt roll), -003 (issue at current average), -011 (transfer value-neutral),
 * -014/-015 (negative-stock guard).
 */
import Decimal from 'decimal.js';
import {
  applyReceipt,
  applyTransferIn,
  averageRate,
  Balance,
  emptyBalance,
  valueIssue,
} from '../../../src/modules/inventory/domain/valuation';
import { NegativeStockError } from '../../../src/modules/inventory/domain/errors';

const bal = (qty: string, value: string): Balance => ({ qty: new Decimal(qty), value: new Decimal(value) });
const D = (v: string) => new Decimal(v);

describe('valuation — weighted-average (FR-INV-002/-003/-011/-014)', () => {
  describe('applyReceipt (FR-INV-002)', () => {
    it('rolls the moving average: (oldValue + q·r)/(oldQty + q)', () => {
      // prev 100 @ 500 = 50000; receive 50 @ 520 → 150 units, value 76000, avg 506.6667
      const next = applyReceipt(bal('100', '50000'), D('50'), D('520'));
      expect(next.qty.toString()).toBe('150');
      expect(next.value.toFixed(4)).toBe('76000.0000');
      expect(averageRate(next)!.toFixed(4)).toBe('506.6667');
    });

    it('first receipt into an empty godown sets the average to its own rate', () => {
      const next = applyReceipt(emptyBalance(), D('50'), D('520'));
      expect(next.qty.toString()).toBe('50');
      expect(next.value.toFixed(4)).toBe('26000.0000');
      expect(averageRate(next)!.toFixed(4)).toBe('520.0000');
    });

    it('is exact decimal — no float drift on an awkward rate', () => {
      // 3 @ 0.3333 = 0.9999, exact
      const next = applyReceipt(emptyBalance(), D('3'), D('0.3333'));
      expect(next.value.toFixed(4)).toBe('0.9999');
    });

    it('rejects a non-positive quantity', () => {
      expect(() => applyReceipt(emptyBalance(), D('0'), D('10'))).toThrow(RangeError);
    });
  });

  describe('valueIssue (FR-INV-003/-014/-015)', () => {
    it('values the issue at the current average and reduces the balance', () => {
      // 150 @ (76000/150 = 506.6667); issue 50 → 50·(76000/150) = 25333.3333 (FR-INV-003)
      const r = valueIssue(bal('150', '76000'), D('50'), { allowNegative: false });
      expect(r.rate.toFixed(4)).toBe('506.6667');
      expect(r.issuedValue.toFixed(4)).toBe('25333.3333');
      expect(r.newBalance.qty.toString()).toBe('100');
    });

    it('draining the whole balance zeroes qty and value (no rounding dust)', () => {
      const r = valueIssue(bal('150', '76000'), D('150'), { allowNegative: false });
      expect(r.issuedValue.toFixed(4)).toBe('76000.0000');
      expect(r.newBalance.qty.toString()).toBe('0');
      expect(r.newBalance.value.toString()).toBe('0');
      expect(averageRate(r.newBalance)).toBeNull();
    });

    it('example from design §9: 50 of 150 @ 76000 → issuedValue 25333.3333', () => {
      const r = valueIssue(bal('150', '76000'), D('50'), { allowNegative: false });
      expect(r.newBalance.qty.toString()).toBe('100');
      expect(r.issuedValue.toFixed(4)).toBe('25333.3333');
    });

    it('throws NegativeStockError when qty > on-hand and not authorised (FR-INV-014)', () => {
      expect(() => valueIssue(bal('10', '5000'), D('50'), { allowNegative: false })).toThrow(
        NegativeStockError,
      );
    });

    it('proceeds into a negative balance when authorised (FR-INV-015)', () => {
      const r = valueIssue(bal('10', '5000'), D('50'), { allowNegative: true });
      expect(r.newBalance.qty.toString()).toBe('-40');
    });

    it('issue against a zero-quantity godown with allowNegative is the negative case', () => {
      expect(() => valueIssue(emptyBalance(), D('5'), { allowNegative: false })).toThrow(
        NegativeStockError,
      );
      const r = valueIssue(emptyBalance(), D('5'), { allowNegative: true });
      expect(r.rate.toString()).toBe('0');
      expect(r.newBalance.qty.toString()).toBe('-5');
    });
  });

  describe('applyTransferIn (FR-INV-011)', () => {
    it('is value-neutral across godowns: in-value equals the value that left the source', () => {
      const source = bal('100', '52000'); // avg 520
      const out = valueIssue(source, D('30'), { allowNegative: false }); // out value 15600
      expect(out.issuedValue.toFixed(4)).toBe('15600.0000');

      const dest = bal('20', '9000'); // avg 450
      const destAfter = applyTransferIn(dest, D('30'), out.issuedValue);

      // summed value across the two godowns is unchanged
      const totalBefore = source.value.plus(dest.value);
      const totalAfter = out.newBalance.value.plus(destAfter.value);
      expect(totalAfter.toFixed(4)).toBe(totalBefore.toFixed(4));

      // only the receiver's average changes
      expect(destAfter.qty.toString()).toBe('50');
      expect(destAfter.value.toFixed(4)).toBe('24600.0000');
      expect(averageRate(destAfter)!.toFixed(4)).toBe('492.0000');
    });
  });

  describe('averageRate', () => {
    it('is value/qty, null when qty is 0', () => {
      expect(averageRate(bal('4', '2080'))!.toFixed(4)).toBe('520.0000');
      expect(averageRate(emptyBalance())).toBeNull();
    });
  });
});
