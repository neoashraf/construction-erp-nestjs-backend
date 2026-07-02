/**
 * TileCatalog (DSH · FR-DSH-001/-006) — PURE domain. The authoritative, in-memory list of the seven
 * Phase-1 KPI tiles. Each tile is addressable in the dashboard payload (and at `…/tiles/:key`) by its
 * stable `key`; the catalog is the single source of truth for the tile keys, their owning source, their
 * drill-down report (a REGISTERED RPT report, FR-DSH-002), the gating permission, and the roles that see
 * them (overview §2 role→tile visibility). Names are unique (asserted by the catalog-integrity unit test).
 *
 * Role visibility (overview §2 / SRS §5): Accounts/Admin → the full financial set; PM/Site Engineer →
 * the project set; Store Keeper → low-stock; HR Manager → attendance-summary. Roles use the platform's
 * canonical role names (see seed-roles-permissions.ts): ADMIN, ACCOUNTS_TEAM, PROJECT_MANAGER,
 * SITE_ENGINEER, STORE_KEEPER, HR_MANAGER.
 */
import { TileDescriptor } from './tile-descriptor';

const ADMIN = 'ADMIN';
const ACCOUNTS = 'ACCOUNTS_TEAM';
const PM = 'PROJECT_MANAGER';
const SITE = 'SITE_ENGINEER';
const STORE = 'STORE_KEEPER';
const HR = 'HR_MANAGER';

/** Gating permissions aligned with each drill-down report's RPT-catalog permission (FR-DSH-010). */
const RPT_READ = 'RPT:READ';
const INV_READ = 'INV:READ';
const HR_READ = 'HR:READ';

export const TILE_CATALOG: TileDescriptor[] = [
  {
    key: 'project-cash-flow',
    title: 'Project Cash Flow',
    source: 'LEDGER',
    drillToReport: 'cash-bank-book',
    requiredPermission: RPT_READ,
    projectScoped: true,
    roles: [ACCOUNTS, ADMIN, PM],
  },
  {
    key: 'pending-ipcs',
    title: 'Pending IPCs',
    source: 'SALES_IPC',
    drillToReport: 'ipc-billing',
    requiredPermission: RPT_READ,
    projectScoped: true,
    roles: [ACCOUNTS, ADMIN, PM],
  },
  {
    key: 'retention-held',
    title: 'Retention Held',
    source: 'SALES_IPC',
    drillToReport: 'ipc-billing',
    requiredPermission: RPT_READ,
    projectScoped: true,
    roles: [ACCOUNTS, ADMIN, PM],
  },
  {
    key: 'low-stock',
    title: 'Low-stock Alerts',
    source: 'INVENTORY',
    drillToReport: 'low-stock',
    requiredPermission: INV_READ,
    projectScoped: true,
    roles: [STORE, ACCOUNTS, ADMIN, PM, SITE],
  },
  {
    key: 'over-budget',
    title: 'Over-budget Alerts',
    source: 'COST_CONTROL',
    drillToReport: 'cost-centre-variance',
    requiredPermission: RPT_READ,
    projectScoped: true,
    roles: [PM, ACCOUNTS, ADMIN],
  },
  {
    key: 'attendance-summary',
    title: 'Attendance Summary',
    source: 'HR',
    drillToReport: 'attendance-summary',
    requiredPermission: HR_READ,
    projectScoped: true,
    roles: [HR, ADMIN],
  },
  {
    key: 'top-receivables-payables',
    title: 'Top Receivables / Payables',
    source: 'LEDGER',
    drillToReport: 'account-ledger',
    requiredPermission: RPT_READ,
    projectScoped: true,
    roles: [ACCOUNTS, ADMIN],
  },
];

/** Look up a tile descriptor by its catalog key (FR-DSH-005); undefined if unknown. */
export function findTile(key: string): TileDescriptor | undefined {
  return TILE_CATALOG.find((t) => t.key === key);
}
