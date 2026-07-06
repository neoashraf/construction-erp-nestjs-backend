/**
 * Catalog integrity (RPT · FR-RPT-001/-009…014/-029). The catalog is the authoritative list: every
 * FR-RPT-009..014 financial report has exactly one descriptor, names are unique, all three formats are
 * offered, and each declares RPT:READ + projectScoped. Later RPT briefs append INVENTORY/HR/PROJECT
 * descriptors — this test guards the LED financial set this brief lands.
 */
import {
  REPORT_CATALOG,
  FINANCIAL_REPORTS,
  INVENTORY_REPORTS,
  REQUISITION_REPORTS,
  HR_REPORTS,
  PROJECT_REPORTS,
  findReport,
} from '../../../src/reports/domain/report-catalog';

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

  it('offers all three formats and gates the LED financial reports on RPT:READ, project-scoped', () => {
    for (const r of FINANCIAL_REPORTS) {
      expect(r.formats).toEqual(['json', 'excel', 'pdf']);
      expect(r.requiredPermission).toEqual({ module: 'RPT', action: 'READ' });
      expect(r.projectScoped).toBe(true);
      expect(r.source).toBe('LEDGER');
      expect(r.name).toBeTruthy();
      expect(r.parameters).toContain('financialYearId');
    }
  });

  it('offers all three formats on every catalog entry (FR-RPT-029)', () => {
    for (const r of REPORT_CATALOG) {
      expect(r.formats).toEqual(['json', 'excel', 'pdf']);
      expect(r.name).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.fr).toMatch(/^FR-RPT-\d{3}$/);
    }
  });

  // ── RPT #31: inventory + requisition + HR reports (FR-RPT-021…028) ──
  it('registers the seven inventory/requisition/HR reports with the expected names', () => {
    const names = [...INVENTORY_REPORTS, ...REQUISITION_REPORTS, ...HR_REPORTS].map((r) => r.name).sort();
    expect(names).toEqual(
      [
        'stock-valuation',
        'low-stock',
        'stock-transfer-summary',
        'requisition-vs-issue',
        'attendance-summary',
        'salary-register',
        'employee-payment-history',
      ].sort(),
    );
  });

  it('covers every inventory/requisition/HR FR (021..024, 026..028) with a descriptor', () => {
    const frs = new Set([...INVENTORY_REPORTS, ...REQUISITION_REPORTS, ...HR_REPORTS].map((r) => r.fr));
    for (const n of [21, 22, 23, 24, 26, 27, 28]) {
      expect(frs.has(`FR-RPT-0${n}`)).toBe(true);
    }
  });

  it('gates each sub-report on its OWNING module READ permission (FR-RPT-008)', () => {
    for (const r of INVENTORY_REPORTS) {
      expect(r.requiredPermission).toEqual({ module: 'INV', action: 'READ' });
      expect(r.source).toBe('INVENTORY');
    }
    for (const r of REQUISITION_REPORTS) {
      expect(r.requiredPermission).toEqual({ module: 'REQ', action: 'READ' });
      expect(r.source).toBe('REQUISITION');
    }
    for (const r of HR_REPORTS) {
      expect(r.requiredPermission).toEqual({ module: 'HR', action: 'READ' });
      expect(r.source).toBe('HR');
    }
  });

  it('marks stock valuation/low-stock as non-project-scoped (stock has no project); the rest project-scoped', () => {
    expect(findReport('stock-valuation')?.projectScoped).toBe(false);
    expect(findReport('low-stock')?.projectScoped).toBe(false);
    expect(findReport('stock-transfer-summary')?.projectScoped).toBe(true);
    expect(findReport('requisition-vs-issue')?.projectScoped).toBe(true);
    expect(findReport('salary-register')?.projectScoped).toBe(true);
  });

  it('marks trial-balance and balance-sheet as balance (as-of) reports; the flow reports as range', () => {
    expect(findReport('trial-balance')?.asOf).toBe(true);
    expect(findReport('balance-sheet')?.asOf).toBe(true);
    expect(findReport('profit-and-loss')?.asOf).toBe(false);
    expect(findReport('daybook')?.asOf).toBe(false);
  });

  // ── RPT #32: project reports (FR-RPT-015…020/-025) ──
  it('registers the six project reports with the expected names', () => {
    const names = PROJECT_REPORTS.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        'project-pnl',
        'ipc-billing',
        'outstanding',
        'material-consumption-vs-budget',
        'labour-cost',
        'cost-centre-variance',
      ].sort(),
    );
  });

  it('covers every project FR (015..020, 025) with a descriptor', () => {
    const frs = new Set(PROJECT_REPORTS.map((r) => r.fr));
    for (const n of [15, 16, 18, 19, 20, 25]) {
      expect(frs.has(`FR-RPT-0${n}`)).toBe(true);
    }
  });

  it('gates every project report on RPT:READ (the reports:project family) and marks it project-scoped', () => {
    for (const r of PROJECT_REPORTS) {
      expect(r.requiredPermission).toEqual({ module: 'RPT', action: 'READ' });
      expect(r.projectScoped).toBe(true);
      expect(r.formats).toEqual(['json', 'excel', 'pdf']);
      expect(r.parameters).toContain('financialYearId');
    }
  });

  it('sources each project report at its owning read model (LED / SALES_IPC / COST_CONTROL)', () => {
    expect(findReport('project-pnl')?.source).toBe('LEDGER');
    expect(findReport('labour-cost')?.source).toBe('LEDGER');
    expect(findReport('ipc-billing')?.source).toBe('SALES_IPC');
    expect(findReport('outstanding')?.source).toBe('SALES_IPC');
    expect(findReport('material-consumption-vs-budget')?.source).toBe('COST_CONTROL');
    expect(findReport('cost-centre-variance')?.source).toBe('COST_CONTROL');
  });

  it('the catalog now contains all 19 Phase-1 reports (6 LED + 3 INV + 1 REQ + 3 HR + 6 project)', () => {
    expect(REPORT_CATALOG).toHaveLength(19);
  });

  it('findReport returns undefined for an unknown name', () => {
    expect(findReport('nope')).toBeUndefined();
  });
});
