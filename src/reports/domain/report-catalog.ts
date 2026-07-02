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
// Sub-report gating maps to the OWNING module's READ permission (module:action RBAC — FR-RPT-008):
// inventory reports → INV:READ, requisition/cost-control → REQ:READ, HR reports → HR:READ.
const INV_READ = { module: 'INV', action: 'READ' } as const;
const REQ_READ = { module: 'REQ', action: 'READ' } as const;
const HR_READ = { module: 'HR', action: 'READ' } as const;

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
 * Inventory reports over INV's stock-ledger projection (FR-RPT-021…023). Gated on INV:READ — the owning
 * module's read permission (a role must hold INV:READ to run them). Stock valuation/low-stock have no
 * project dimension (stock is per godown/item) → not project-scoped; the transfer summary carries a
 * project → project-scoped (F4).
 */
export const INVENTORY_REPORTS: ReportDescriptor[] = [
  {
    name: 'stock-valuation',
    title: 'Stock Valuation (per Godown)',
    source: 'INVENTORY',
    fr: 'FR-RPT-021',
    parameters: ['financialYearId', 'godownId', 'itemId', 'asOf', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: INV_READ,
    projectScoped: false,
    asOf: true,
  },
  {
    name: 'low-stock',
    title: 'Low Stock / Re-order',
    source: 'INVENTORY',
    fr: 'FR-RPT-022',
    parameters: ['financialYearId', 'godownId', 'reorderLevel', 'asOf', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: INV_READ,
    projectScoped: false,
    asOf: true,
  },
  {
    name: 'stock-transfer-summary',
    title: 'Stock-Journal Transfer / Issue Summary',
    source: 'INVENTORY',
    fr: 'FR-RPT-023',
    parameters: ['financialYearId', 'godownId', 'itemId', 'projectId', 'dateFrom', 'dateTo', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: INV_READ,
    projectScoped: true,
    asOf: false,
  },
];

/**
 * Requisition & cost-control reports over REQ's requisition/issue projection (FR-RPT-024). Gated on
 * REQ:READ (owned-module consistent); project-scoped (F4).
 */
export const REQUISITION_REPORTS: ReportDescriptor[] = [
  {
    name: 'requisition-vs-issue',
    title: 'Requisition vs Issue',
    source: 'REQUISITION',
    fr: 'FR-RPT-024',
    parameters: ['financialYearId', 'projectId', 'costCentreId', 'requisitionId', 'dateFrom', 'dateTo', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: REQ_READ,
    projectScoped: true,
    asOf: false,
  },
];

/**
 * HR reports over HR's salary/attendance projection + PAY's settlement surface (FR-RPT-026…028). Gated on
 * HR:READ — restricted to HR/Admin (a role without HR:READ is 403). Project-scoped where the row carries a
 * project (F4), but the HR:READ gate is the primary control.
 */
export const HR_REPORTS: ReportDescriptor[] = [
  {
    name: 'attendance-summary',
    title: 'Monthly Attendance Summary',
    source: 'HR',
    fr: 'FR-RPT-026',
    parameters: ['month', 'projectId', 'employeeId', 'costCentreId', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: HR_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'salary-register',
    title: 'Salary Register',
    source: 'HR',
    fr: 'FR-RPT-027',
    parameters: ['salaryRunId', 'financialYearId', 'month', 'projectId', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: HR_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'employee-payment-history',
    title: 'Employee Payment History',
    source: 'HR',
    fr: 'FR-RPT-028',
    parameters: ['employeeId', 'financialYearId', 'dateFrom', 'dateTo', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: HR_READ,
    projectScoped: true,
    asOf: false,
  },
];

/**
 * Project reports (RPT #32 · FR-RPT-015…020/-025). Project P&L and labour-cost are LED queries; the IPC
 * reports render SAL's per-IPC outstanding/retention (never a parallel total); material-consumption and
 * cost-centre-variance consume CC's canonical budget-vs-actual. All gated on RPT:READ (the reports:project
 * family — a PM holds RPT:READ ASSIGNED) and project-scoped (F4). `project-pnl` requires a `projectId`.
 */
export const PROJECT_REPORTS: ReportDescriptor[] = [
  {
    name: 'project-pnl',
    title: 'Project P&L',
    source: 'LEDGER',
    fr: 'FR-RPT-015',
    parameters: ['financialYearId', 'projectId', 'costCentreId', 'dateFrom', 'dateTo', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'ipc-billing',
    title: 'IPC Billed vs Certified vs Received',
    source: 'SALES_IPC',
    fr: 'FR-RPT-016',
    parameters: ['financialYearId', 'projectId', 'dateFrom', 'dateTo', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'outstanding',
    title: 'Outstanding per Project & IPC',
    source: 'SALES_IPC',
    fr: 'FR-RPT-020',
    parameters: ['financialYearId', 'projectId', 'asOf', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: true,
  },
  {
    name: 'material-consumption-vs-budget',
    title: 'Material Consumption vs Budget',
    source: 'COST_CONTROL',
    fr: 'FR-RPT-018',
    parameters: ['financialYearId', 'projectId', 'costCentreId', 'dateFrom', 'dateTo', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'labour-cost',
    title: 'Labour Cost per Cost Centre',
    source: 'LEDGER',
    fr: 'FR-RPT-019',
    parameters: ['financialYearId', 'projectId', 'costCentreId', 'dateFrom', 'dateTo', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: false,
  },
  {
    name: 'cost-centre-variance',
    title: 'Cost-Centre Variance',
    source: 'COST_CONTROL',
    fr: 'FR-RPT-025',
    parameters: ['financialYearId', 'projectId', 'costCentreId', 'dateFrom', 'dateTo', 'status', 'format', 'page', 'pageSize'],
    formats: ALL_FORMATS,
    requiredPermission: RPT_READ,
    projectScoped: true,
    asOf: false,
  },
];

/**
 * The full report catalog. Phase-1: the six LED financial reports (#29/#30), the inventory + requisition +
 * HR reports (#31), and the project reports (#32).
 */
export const REPORT_CATALOG: ReportDescriptor[] = [
  ...FINANCIAL_REPORTS,
  ...INVENTORY_REPORTS,
  ...REQUISITION_REPORTS,
  ...HR_REPORTS,
  ...PROJECT_REPORTS,
];

/** Look up a descriptor by its catalog name (FR-RPT-001). */
export function findReport(name: string): ReportDescriptor | undefined {
  return REPORT_CATALOG.find((r) => r.name === name);
}
