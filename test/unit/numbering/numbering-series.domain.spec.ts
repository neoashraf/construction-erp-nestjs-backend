/**
 * NumberingSeries domain-helper unit tests (no DB) — formatting + zero-padding incl. overflow,
 * FY short label, prefix/padding validation (FR-NUM-002, FR-NUM-013, SRS §11, Edge Case 8).
 */
import {
  defaultPrefixFor,
  formatVoucherNumber,
  fyShortLabel,
  normalizePaddingWidth,
  normalizePrefix,
} from '../../../src/core/numbering/domain/numbering-series';
import { ValidationError } from '../../../src/common/errors/domain-error';

describe('NumberingSeries domain helpers', () => {
  it('formats <prefix>/<fyLabel>/<zeroPad(seq)>', () => {
    expect(formatVoucherNumber('IPC', '2526', 1, 4)).toBe('IPC/2526/0001');
    expect(formatVoucherNumber('PV', '2526', 42, 4)).toBe('PV/2526/0042');
  });

  it('renders a sequence longer than the pad width at full length (Edge Case 8)', () => {
    expect(formatVoucherNumber('IPC', '2526', 10000, 4)).toBe('IPC/2526/10000');
  });

  it('derives the FY short label from start/end years (2025-26 → 2526)', () => {
    expect(fyShortLabel(2025, 2026)).toBe('2526');
    expect(fyShortLabel(2026, 2027)).toBe('2627');
  });

  it('maps each voucher type to a default prefix', () => {
    expect(defaultPrefixFor('SALES_IPC')).toBe('IPC');
    expect(defaultPrefixFor('JOURNAL')).toBe('JV');
  });

  it('normalizes a valid prefix and rejects bad ones', () => {
    expect(normalizePrefix('  IPC ')).toBe('IPC');
    expect(() => normalizePrefix('')).toThrow(ValidationError);
    expect(() => normalizePrefix('IP/C')).toThrow(ValidationError);
    expect(() => normalizePrefix('IP C')).toThrow(ValidationError);
  });

  it('defaults padding width to 4 and rejects < 1', () => {
    expect(normalizePaddingWidth(undefined)).toBe(4);
    expect(normalizePaddingWidth(6)).toBe(6);
    expect(() => normalizePaddingWidth(0)).toThrow(ValidationError);
    expect(() => normalizePaddingWidth(-1)).toThrow(ValidationError);
  });
});
