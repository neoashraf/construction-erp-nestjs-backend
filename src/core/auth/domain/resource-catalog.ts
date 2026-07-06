/**
 * Resource Catalogue (AUD RBAC v2 — FR-AUD-035). PURE TypeScript; no NestJS/TypeORM.
 *
 * Permissions are RESOURCE (screen/feature) level: each nav item is its own grant key, so per-screen
 * visibility is exact (a role can hold one screen of a module without its siblings). This static
 * in-code list is the single source of truth for:
 *   - the `RolesGuard` (@RequirePermission(resource, action) is validated against it — an out-of-catalogue
 *     resource/action is a build error, not a silent bypass),
 *   - the `POST /api/permissions` / `POST /api/roles` write validation (VALIDATION_ERROR on unknown code),
 *   - `GET /api/permissions/catalog` (grouped by module) which drives the Roles & Permissions editor grid.
 *
 * Codes + grouping mirror docs/design/screens/00-app-shell/nav-tree-admin.md (the canonical catalogue).
 * `actions` is each resource's applicable action set — READ (the nav-visibility grant) plus the write /
 * lifecycle actions its screen's routes enforce server-side.
 */
import { ActionCode } from './permission.entity';

export interface ResourceDef {
  /** Screen/feature code, e.g. `cost_control.profitability`. */
  readonly resource: string;
  /** Owning nav module code (groups the catalogue). */
  readonly module: string;
  /** Human label for the editor. */
  readonly label: string;
  /** Applicable actions (always includes READ). */
  readonly actions: readonly ActionCode[];
}

export interface CatalogModule {
  readonly module: string;
  readonly label: string;
  readonly resources: readonly ResourceDef[];
}

const R: ActionCode = 'READ';
const C: ActionCode = 'CREATE';
const U: ActionCode = 'UPDATE';
const D: ActionCode = 'DELETE';
const P: ActionCode = 'POST';
const X: ActionCode = 'CANCEL';
const A: ActionCode = 'APPROVE';
const J: ActionCode = 'REJECT';

/** The catalogue, grouped by module (the shape `GET /api/permissions/catalog` returns). */
export const RESOURCE_CATALOG: readonly CatalogModule[] = [
  {
    module: 'DSH', label: 'Dashboard', resources: [
      { resource: 'dashboard', module: 'DSH', label: 'Dashboard', actions: [R] },
    ],
  },
  {
    module: 'SAL', label: 'Sales / IPC', resources: [
      { resource: 'sales.ipcs', module: 'SAL', label: 'IPCs', actions: [R, C, U, D, P, X] },
      { resource: 'sales.ipc_register', module: 'SAL', label: 'IPC register & retention', actions: [R] },
    ],
  },
  {
    module: 'REC', label: 'Receipts', resources: [
      { resource: 'receipts', module: 'REC', label: 'Receipts', actions: [R, C, U, D, P, X] },
    ],
  },
  {
    module: 'PUR', label: 'Purchases', resources: [
      { resource: 'purchase.orders', module: 'PUR', label: 'Purchase orders', actions: [R, C, U, A, X] },
      { resource: 'purchase.bills', module: 'PUR', label: 'Purchase bills', actions: [R, C, U, D, P, X] },
      { resource: 'purchase.grn', module: 'PUR', label: 'GRN & matching', actions: [R, C, P] },
    ],
  },
  {
    module: 'PAY', label: 'Payments', resources: [
      { resource: 'payments.list', module: 'PAY', label: 'Payments', actions: [R, C, U, D, P, X] },
      { resource: 'payments.open_payables', module: 'PAY', label: 'Open payables', actions: [R] },
    ],
  },
  {
    module: 'GEN', label: 'Contra & Journal', resources: [
      { resource: 'contra_journal.vouchers', module: 'GEN', label: 'Vouchers', actions: [R, C, U, D, P, X] },
      { resource: 'contra_journal.opening', module: 'GEN', label: 'Opening balances', actions: [R, C, U, P] },
    ],
  },
  {
    module: 'INV', label: 'Inventory', resources: [
      { resource: 'inventory.stock_journals', module: 'INV', label: 'Stock journals', actions: [R, C, U, D, A, P, X] },
      { resource: 'inventory.stock_ledger', module: 'INV', label: 'Stock ledger', actions: [R] },
    ],
  },
  {
    module: 'REQ', label: 'Requisitions', resources: [
      { resource: 'requisitions.list', module: 'REQ', label: 'Requisitions', actions: [R, C, U, D] },
      { resource: 'requisitions.approvals', module: 'REQ', label: 'Approvals', actions: [R, A, J] },
      { resource: 'requisitions.issues', module: 'REQ', label: 'Issues', actions: [R, U] },
    ],
  },
  {
    module: 'HR', label: 'HR & Payroll', resources: [
      { resource: 'hr.employees', module: 'HR', label: 'Employees', actions: [R, C, U] },
      { resource: 'hr.attendance', module: 'HR', label: 'Attendance', actions: [R, C, U, P, X] },
      { resource: 'hr.salary_sheets', module: 'HR', label: 'Salary sheets', actions: [R, C, U, P, X] },
    ],
  },
  {
    module: 'LED', label: 'Ledger', resources: [
      { resource: 'ledger.journal_entries', module: 'LED', label: 'Journal entries', actions: [R] },
      { resource: 'ledger.account_ledger', module: 'LED', label: 'Account ledger', actions: [R] },
      { resource: 'ledger.trial_balance', module: 'LED', label: 'Trial balance', actions: [R] },
    ],
  },
  {
    module: 'CC', label: 'Cost control', resources: [
      { resource: 'cost_control.budget_vs_actual', module: 'CC', label: 'Budget vs actual', actions: [R] },
      { resource: 'cost_control.alerts', module: 'CC', label: 'Over-budget alerts', actions: [R] },
      { resource: 'cost_control.profitability', module: 'CC', label: 'Profitability', actions: [R] },
    ],
  },
  {
    module: 'RPT', label: 'Reports', resources: [
      { resource: 'reports', module: 'RPT', label: 'Reports', actions: [R] },
    ],
  },
  {
    module: 'MAS', label: 'Master data', resources: [
      // CREATE added by #44's drift reconciliation: POST /api/masters/companies demanded it while
      // the catalogue declared only R/U — an undeclarable grant no role (incl. Admin) could hold.
      { resource: 'master_data.company_settings', module: 'MAS', label: 'Company settings', actions: [R, C, U] },
      { resource: 'master_data.financial_years', module: 'MAS', label: 'Financial years', actions: [R, C, U] },
      { resource: 'master_data.projects', module: 'MAS', label: 'Projects', actions: [R, C, U, D] },
      { resource: 'master_data.cost_centres', module: 'MAS', label: 'Cost centres', actions: [R, C, U, D] },
      { resource: 'master_data.purposes', module: 'MAS', label: 'Purposes', actions: [R, C, U, D] },
      { resource: 'master_data.chart_of_accounts', module: 'MAS', label: 'Chart of accounts', actions: [R, C, U, D] },
      { resource: 'master_data.parties', module: 'MAS', label: 'Parties', actions: [R, C, U, D] },
      { resource: 'master_data.items', module: 'MAS', label: 'Items', actions: [R, C, U, D] },
    ],
  },
  {
    module: 'NUM', label: 'Numbering', resources: [
      { resource: 'numbering', module: 'NUM', label: 'Numbering', actions: [R, C, U] },
    ],
  },
  {
    module: 'PER', label: 'Periods', resources: [
      { resource: 'periods', module: 'PER', label: 'Periods', actions: [R, U] },
    ],
  },
  {
    module: 'AUD', label: 'Audit & access', resources: [
      { resource: 'audit.users', module: 'AUD', label: 'Users', actions: [R, C, U] },
      { resource: 'audit.roles', module: 'AUD', label: 'Roles & permissions', actions: [R, C, U, D] },
      { resource: 'audit.audit_log', module: 'AUD', label: 'Audit log', actions: [R] },
    ],
  },
];

/** Flat map resource-code → definition. */
export const RESOURCE_DEFS: ReadonlyMap<string, ResourceDef> = new Map(
  RESOURCE_CATALOG.flatMap(m => m.resources.map(r => [r.resource, r] as const)),
);

/** All valid resource codes. */
export const RESOURCE_CODES: readonly string[] = [...RESOURCE_DEFS.keys()];

/** True iff `resource` is a catalogue code. */
export function isValidResource(resource: string): boolean {
  return RESOURCE_DEFS.has(resource);
}

/** True iff `resource` exists AND allows `action`. */
export function resourceAllowsAction(resource: string, action: ActionCode): boolean {
  const def = RESOURCE_DEFS.get(resource);
  return !!def && def.actions.includes(action);
}
