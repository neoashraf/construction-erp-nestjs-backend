import { PhoneNumber } from '../../src/common/value-objects/phone-number';
import { Tin } from '../../src/common/value-objects/tin';
import { Bin } from '../../src/common/value-objects/bin';
import { DateOnly } from '../../src/common/value-objects/date-only';
import { ValidationError } from '../../src/common/errors/domain-error';

describe('shared value objects', () => {
  describe('PhoneNumber (E.164)', () => {
    it('accepts a Bangladeshi E.164 number', () => {
      const p = PhoneNumber.of('+8801712345678');
      expect(p.value).toBe('+8801712345678');
      expect(p.isBangladeshi()).toBe(true);
    });
    it('rejects a non-E.164 number', () => {
      expect(() => PhoneNumber.of('01712345678')).toThrow(ValidationError);
    });
  });

  describe('Tin / Bin', () => {
    it('accepts a 12-digit TIN and 13-digit BIN', () => {
      expect(Tin.of('123456789012').value).toBe('123456789012');
      expect(Bin.of('1234567890123').value).toBe('1234567890123');
    });
    it('rejects wrong-length identifiers', () => {
      expect(() => Tin.of('123').toString()).toThrow(ValidationError);
      expect(() => Bin.of('123').toString()).toThrow(ValidationError);
    });
  });

  describe('DateOnly', () => {
    it('parses an ISO date and compares', () => {
      const a = DateOnly.of('2025-07-01');
      const b = DateOnly.of('2026-06-30');
      expect(a.isBefore(b)).toBe(true);
      expect(b.isAfter(a)).toBe(true);
    });
    it('rejects a malformed or non-existent date', () => {
      expect(() => DateOnly.of('2025/07/01')).toThrow(ValidationError);
      expect(() => DateOnly.of('2025-02-30')).toThrow(ValidationError);
    });
  });
});
