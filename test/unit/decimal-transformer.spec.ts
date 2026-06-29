import Decimal from 'decimal.js';
import {
  moneyTransformer,
  qtyTransformer,
} from '../../src/database/persistence/decimal.transformer';

describe('decimal column transformers', () => {
  describe('moneyTransformer (numeric(18,4))', () => {
    it('writes a Decimal as a fixed 4-dp string', () => {
      expect(moneyTransformer.to(new Decimal('1500.5'))).toBe('1500.5000');
    });

    it('reads a DB string back into a Decimal', () => {
      const value = moneyTransformer.from('1500.5000');
      expect(value).toBeInstanceOf(Decimal);
      expect((value as Decimal).equals(new Decimal('1500.5'))).toBe(true);
    });

    it('round-trips without precision loss', () => {
      const original = new Decimal('99999999999999.1234');
      const persisted = moneyTransformer.to(original);
      const restored = moneyTransformer.from(persisted as string) as Decimal;
      expect(restored.equals(original)).toBe(true);
    });

    it('maps null/undefined to null both ways', () => {
      expect(moneyTransformer.to(null)).toBeNull();
      expect(moneyTransformer.to(undefined)).toBeNull();
      expect(moneyTransformer.from(null)).toBeNull();
    });
  });

  describe('qtyTransformer (numeric(18,3))', () => {
    it('writes a Decimal as a fixed 3-dp string', () => {
      expect(qtyTransformer.to(new Decimal('12.5'))).toBe('12.500');
    });

    it('reads a DB string back into a Decimal', () => {
      const value = qtyTransformer.from('12.500') as Decimal;
      expect(value.equals(new Decimal('12.5'))).toBe(true);
    });
  });
});
