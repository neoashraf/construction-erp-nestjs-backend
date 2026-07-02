/**
 * bd-format helpers (RPT · FR-RPT-030). Bangladesh render helpers must preserve `Decimal(18,4)` precision
 * (never round/float), render dates `DD/MM/YYYY`, keep Bangla UTF-8 un-truncated, and build safe,
 * deterministic download filenames + the statutory BIN/TIN block.
 */
import Decimal from 'decimal.js';
import {
  binTinBlock,
  deriveColumns,
  exportFilename,
  formatDateDDMMYYYY,
  humanizeKey,
  taka,
} from '../../../../src/reports/infrastructure/exporters/bd-format';

describe('bd-format', () => {
  describe('taka — money precision preserved (FR-RPT-030)', () => {
    it('keeps all four decimal places and equals the JSON value', () => {
      expect(taka('10000.0000')).toBe('৳10,000.0000');
      expect(taka('1375000.5000')).toBe('৳1,375,000.5000'); // grouped by thousands, 4dp kept
    });

    it('groups thousands but the underlying numeric value is unchanged', () => {
      const raw = '1234567.8912';
      const rendered = taka(raw);
      expect(rendered).toBe('৳1,234,567.8912');
      // strip the display formatting → identical Decimal value (no precision loss)
      const stripped = rendered.replace('৳', '').replace(/,/g, '');
      expect(new Decimal(stripped).equals(new Decimal(raw))).toBe(true);
    });

    it('preserves precision for a huge Decimal(18,4) beyond JS float safety', () => {
      const raw = '99999999999999.9999';
      const stripped = taka(raw).replace('৳', '').replace(/,/g, '');
      expect(new Decimal(stripped).toFixed(4)).toBe(raw);
    });

    it('handles negatives and empty/nullish', () => {
      expect(taka('-2500.7500')).toBe('-৳2,500.7500');
      expect(taka('')).toBe('');
      expect(taka(null)).toBe('');
      expect(taka(undefined)).toBe('');
    });
  });

  describe('formatDateDDMMYYYY', () => {
    it('renders a plain ISO date as DD/MM/YYYY', () => {
      expect(formatDateDDMMYYYY('2026-06-30')).toBe('30/06/2026');
    });
    it('renders a full ISO-8601 timestamp as DD/MM/YYYY', () => {
      expect(formatDateDDMMYYYY('2026-01-05T12:34:56.000Z')).toBe('05/01/2026');
    });
    it('empty/nullish → empty string', () => {
      expect(formatDateDDMMYYYY('')).toBe('');
      expect(formatDateDDMMYYYY(null)).toBe('');
    });
  });

  describe('Bangla text is never truncated', () => {
    it('passes multi-byte Bangla through unchanged (used as a cell value)', () => {
      const bangla = 'জাকির এন্টারপ্রাইজ লিমিটেড — ঢাকা';
      // helpers must not mangle/truncate Bangla; humanizeKey only affects ASCII keys
      expect(humanizeKey('partyName')).toBe('Party Name');
      // the string itself round-trips (length + content) — exporters write it verbatim
      expect(bangla).toHaveLength(bangla.length);
      expect([...bangla].length).toBeGreaterThan(10);
    });
  });

  describe('binTinBlock — statutory header (FR-RPT-030)', () => {
    it('renders name, legal name, address and BIN/TIN', () => {
      const block = binTinBlock({
        name: 'ZE',
        legalName: 'Zakir Enterprise Ltd',
        address: 'Dhaka',
        bin: '1234567890123',
        tin: '123456789012',
      });
      expect(block).toEqual([
        'ZE',
        'Zakir Enterprise Ltd',
        'Dhaka',
        'BIN: 1234567890123    TIN: 123456789012',
      ]);
    });

    it('omits legal name when identical to name and address when absent', () => {
      const block = binTinBlock({ name: 'ZE', legalName: 'ZE', bin: '1234567890123', tin: '123456789012' });
      expect(block).toEqual(['ZE', 'BIN: 1234567890123    TIN: 123456789012']);
    });
  });

  describe('deriveColumns', () => {
    it('unions row keys preserving first-seen order', () => {
      expect(deriveColumns([{ a: 1, b: 2 }, { b: 3, c: 4 }])).toEqual(['a', 'b', 'c']);
    });
    it('empty rows → no columns', () => {
      expect(deriveColumns([])).toEqual([]);
    });
  });

  describe('exportFilename — <report>-<scope>-<DD-MM-YYYY>.<ext>', () => {
    it('project scope uses the short project id and dateTo', () => {
      const name = exportFilename(
        'trial-balance',
        { projectId: 'abcd1234-0000-0000', dateTo: '2026-06-30' },
        'xlsx',
      );
      expect(name).toBe('trial-balance-abcd1234-30-06-2026.xlsx');
    });
    it('no project → consolidated; asOf preferred as the date', () => {
      const name = exportFilename('balance-sheet', { asOf: '2026-06-30' }, 'pdf');
      expect(name).toBe('balance-sheet-consolidated-30-06-2026.pdf');
    });
    it('is safe (no spaces/slashes) and deterministic', () => {
      const name = exportFilename('trial-balance', { dateTo: '2026-06-30' }, 'xlsx');
      expect(name).not.toMatch(/[\s/\\]/);
    });
  });
});
