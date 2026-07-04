/**
 * Idempotent seed — six BUILT-IN roles (is_system=true) + resource-level default permission sets +
 * is_unscoped flags (AUD RBAC v2 — FR-AUD-011/034/035). Run after the RbacV2 migration.
 *
 * Grants are RESOURCE (screen/feature) level per docs/design/screens/00-app-shell/nav-tree-by-role.md §1.
 * Seed-if-absent: re-running never duplicates and never clobbers Admin-edited grants on existing roles.
 *
 * Usage: import and call seedRolesPermissions(dataSource, companyId).
 */
import { DataSource } from 'typeorm';
import { RESOURCE_CATALOG, RESOURCE_DEFS, ResourceDef } from '../../core/auth/domain/resource-catalog';

type Scope = 'ALL' | 'ASSIGNED';
type Grant = { resource: string; actions: readonly string[] };
type RoleSeed = {
  name: string;
  isUnscoped: boolean;
  approvalLimit: string | null;
  scope: Scope;
  grants: Grant[];
};

/** All applicable actions of a resource (full control). */
function all(resource: string): Grant {
  const def = RESOURCE_DEFS.get(resource) as ResourceDef;
  return { resource, actions: def.actions };
}
/** READ-only grant. */
function read(resource: string): Grant {
  return { resource, actions: ['READ'] };
}
/** Explicit action subset. */
function grant(resource: string, ...actions: string[]): Grant {
  return { resource, actions };
}

// ADMIN holds every resource with all its actions (superuser).
const ADMIN_GRANTS: Grant[] = RESOURCE_CATALOG.flatMap(m => m.resources.map(r => all(r.resource)));

const ROLE_SEEDS: RoleSeed[] = [
  {
    name: 'ADMIN',
    isUnscoped: true,
    approvalLimit: null,
    scope: 'ALL',
    grants: ADMIN_GRANTS,
  },
  {
    // Accounts Manager — full financial lifecycle, unscoped (org-wide).
    name: 'ACCOUNTS_MANAGER',
    isUnscoped: true,
    approvalLimit: null,
    scope: 'ALL',
    grants: [
      read('dashboard'),
      all('sales.ipcs'), read('sales.ipc_register'),
      all('receipts'),
      all('purchase.orders'), all('purchase.bills'), read('purchase.grn'),
      all('payments.list'), read('payments.open_payables'),
      all('contra_journal.vouchers'), all('contra_journal.opening'),
      read('inventory.stock_journals'), read('inventory.stock_ledger'),
      read('requisitions.list'), grant('requisitions.approvals', 'READ', 'APPROVE', 'REJECT'),
      read('ledger.journal_entries'), read('ledger.account_ledger'), read('ledger.trial_balance'),
      read('cost_control.budget_vs_actual'), read('cost_control.alerts'), read('cost_control.profitability'),
      read('reports'),
      read('master_data.chart_of_accounts'), read('master_data.parties'), read('master_data.items'),
      all('periods'),
    ],
  },
  {
    // Project Manager — assigned-project scope; deliberately narrow (resource-level exactness).
    name: 'PROJECT_MANAGER',
    isUnscoped: false,
    approvalLimit: null,
    scope: 'ASSIGNED',
    grants: [
      read('dashboard'),
      read('sales.ipcs'), read('sales.ipc_register'),
      read('inventory.stock_ledger'),
      grant('requisitions.list', 'READ', 'CREATE', 'UPDATE', 'DELETE'),
      grant('requisitions.approvals', 'READ', 'APPROVE', 'REJECT'),
      read('ledger.account_ledger'),
      read('cost_control.budget_vs_actual'), read('cost_control.alerts'),
      read('reports'),
      read('master_data.projects'),
    ],
  },
  {
    // Site Engineer — captures requisitions + attendance for their site.
    name: 'SITE_ENGINEER',
    isUnscoped: false,
    approvalLimit: null,
    scope: 'ASSIGNED',
    grants: [
      read('dashboard'),
      grant('requisitions.list', 'READ', 'CREATE'),
      grant('hr.attendance', 'READ', 'CREATE'),
    ],
  },
  {
    // Store Keeper — GRN, stock journals, requisition issues.
    name: 'STORE_KEEPER',
    isUnscoped: false,
    approvalLimit: null,
    scope: 'ASSIGNED',
    grants: [
      read('dashboard'),
      grant('purchase.grn', 'READ', 'CREATE', 'POST'),
      grant('inventory.stock_journals', 'READ', 'CREATE', 'UPDATE', 'POST', 'CANCEL'),
      read('inventory.stock_ledger'),
      read('requisitions.list'),
      grant('requisitions.issues', 'READ', 'UPDATE'),
    ],
  },
  {
    // HR Manager — org-wide (unscoped): employee master, attendance, payroll.
    name: 'HR_MANAGER',
    isUnscoped: true,
    approvalLimit: null,
    scope: 'ALL',
    grants: [
      read('dashboard'),
      grant('hr.employees', 'READ', 'CREATE', 'UPDATE'),
      // HR Manager owns daily-labour confirmation (SRS 12 §7.C) — attendance R + confirm(POST)/reverse(CANCEL).
      grant('hr.attendance', 'READ', 'CREATE', 'UPDATE', 'POST', 'CANCEL'),
      all('hr.salary_sheets'),
      read('reports'),
    ],
  },
];

export async function seedRolesPermissions(dataSource: DataSource, companyId: string): Promise<void> {
  for (const seed of ROLE_SEEDS) {
    // Upsert the built-in role (is_system=true).
    const existing = await dataSource.query(
      `SELECT id FROM "role" WHERE company_id = $1 AND name = $2`,
      [companyId, seed.name],
    );
    let roleId: string;
    if (existing.length > 0) {
      roleId = existing[0].id;
      await dataSource.query(
        `UPDATE "role" SET is_system = true, is_unscoped = $1, approval_limit = $2 WHERE id = $3`,
        [seed.isUnscoped, seed.approvalLimit, roleId],
      );
    } else {
      roleId = crypto.randomUUID();
      await dataSource.query(
        `INSERT INTO "role" (id, company_id, name, is_system, is_unscoped, approval_limit, version)
         VALUES ($1, $2, $3, true, $4, $5, 1)`,
        [roleId, companyId, seed.name, seed.isUnscoped, seed.approvalLimit],
      );
    }

    // Idempotent resource-level permissions: insert only if the (role, resource, action) is missing.
    for (const g of seed.grants) {
      for (const action of g.actions) {
        const existingPerm = await dataSource.query(
          `SELECT id FROM "permission" WHERE role_id = $1 AND resource = $2 AND action = $3`,
          [roleId, g.resource, action],
        );
        if (existingPerm.length === 0) {
          await dataSource.query(
            `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version)
             VALUES ($1, $2, $3, $4, $5, $6, 1)`,
            [crypto.randomUUID(), roleId, companyId, g.resource, action, seed.scope],
          );
        }
      }
    }
  }
}
