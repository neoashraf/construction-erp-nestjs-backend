/**
 * Catalog integrity (RPT · FR-RPT-001/-009…014/-029). The catalog is the authoritative list: every
 * FR-RPT-009..014 financial report has exactly one descriptor, names are unique, all three formats are
 * offered, and each declares RPT:READ + projectScoped. Later RPT briefs append INVENTORY/HR/PROJECT
 * descriptors — this test guards the LED financial set this brief lands.
 */
import { REPORT_CATALOG, FINANCIAL_REPORTS, findReport } from '../../../src/reports/domain/report-catalog';

describe('ReportCatalog integrity', () => {
  it('registers all six LED financial reports with the expected names', () => {
    const names = FINANCIAL_REPORTS.map((r) => r.name).sort();
    expect(names).toEqual(
      ['account-ledger', 'balance-sheet', 'cash-bank-book', 'daybook', 'profit-and-loss', 'trial-balance'].sort(),
    );
  });

  it('covers every financial FR (FR-RPT-009..014) with a descriptor', () => {
    const frs = new Set(FINANCIAL_REPORTS.map((r) => r.fr));
    for (let n = 9; n <= 14; n++) {
      expect(frs.has(`FR-RPT-0${n < 10 ? '0' : ''}${n}`)).toBe(true);
    }
  });

  it('has unique report names across the catalog', () => {
    const names = REPORT_CATALOG.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('offers all three formats and gates every report on RPT:READ, project-scoped', () => {
    for (const r of REPORT_CATALOG) {
      expect(r.formats).toEqual(['json', 'excel', 'pdf']);
      expect(r.requiredPermission).toEqual({ module: 'RPT', action: 'READ' });
      expect(r.projectScoped).toBe(true);
      expect(r.source).toBe('LEDGER');
      expect(r.name).toBeTruthy();
      expect(r.parameters).toContain('financialYearId');
    }
  });

  it('marks trial-balance and balance-sheet as balance (as-of) reports; the flow reports as range', () => {
    expect(findReport('trial-balance')?.asOf).toBe(true);
    expect(findReport('balance-sheet')?.asOf).toBe(true);
    expect(findReport('profit-and-loss')?.asOf).toBe(false);
    expect(findReport('daybook')?.asOf).toBe(false);
  });

  it('findReport returns undefined for an unknown name', () => {
    expect(findReport('nope')).toBeUndefined();
  });
});
