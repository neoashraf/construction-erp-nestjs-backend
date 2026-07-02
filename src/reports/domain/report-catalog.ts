/**
 * ReportCatalog (RPT · FR-RPT-001) — PURE domain. The authoritative, in-memory list of Phase-1 reports.
 * Each report is addressable at `/api/reports/<name>`; the catalog is the single source of truth for the
 * report names, their sources, parameters, formats, and gating permission. This brief registers the six
 * LED-sourced financial statements & registers (FR-RPT-009…014); later RPT briefs append the INVENTORY,
 * HR, and PROJECT descriptors. Names are unique (asserted by the catalog-integrity unit test).
 */
import { ReportDescriptor, ReportFormat } from './report-descriptor';

const ALL_FORMATS: ReportFormat[] = ['json', 'excel', 'pdf'];
const RPT_READ = { module: 'RPT', action: 'READ' } as const;

/** Common financial-report params (company is implicit from the JWT — never a parameter, FR-RPT-002). */
const COMMON = ['financialYearId', 'projectId', 'costCentreId', 'dateFrom', 'dateTo', 'format'];

export const FINANCIAL_REPORTS: ReportDescriptor[] = [
  {
    name: 'trial-balance',
    title: 'Trial Balance',
    source: 'LEDGER',
    fr: 'FR-RPT-009',
    parameters: [...COMMON, 'periodId', 'groupBy', 'purposeId', 'godownId', 'partyId', 'accountId'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: true,
  },
  {
    name: 'account-ledger',
    title: 'Account Ledger',
    source: 'LEDGER',
    fr: 'FR-RPT-010',
    parameters: ['financialYearId', 'accountId', 'partyId', 'dateFrom', 'dateTo', 'projectId', 'format'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'daybook',
    title: 'Daybook',
    source: 'LEDGER',
    fr: 'FR-RPT-011',
    parameters: ['financialYearId', 'dateFrom', 'dateTo', 'voucherType', 'projectId', 'format'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'cash-bank-book',
    title: 'Cash / Bank Book',
    source: 'LEDGER',
    fr: 'FR-RPT-012',
    parameters: ['financialYearId', 'accountId', 'dateFrom', 'dateTo', 'projectId', 'format'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'profit-and-loss',
    title: 'Profit & Loss',
    source: 'LEDGER',
    fr: 'FR-RPT-013',
    parameters: [...COMMON, 'groupBy'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'balance-sheet',
    title: 'Balance Sheet',
    source: 'LEDGER',
    fr: 'FR-RPT-014',
    parameters: ['financialYearId', 'asOf', 'periodId', 'projectId', 'format'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: true,
  },
];

/**
 * The full report catalog. Phase-1: the six LED financial reports. Later RPT briefs append inventory
 * (#31), HR (#31), and project (#32) descriptors here.
 */
export const REPORT_CATALOG: ReportDescriptor[] = [...FINANCIAL_REPORTS];

/** Look up a descriptor by its catalog name (FR-RPT-001). */
export function findReport(name: string): ReportDescriptor | undefined {
  return REPORT_CATALOG.find((r) => r.name === name);
}
