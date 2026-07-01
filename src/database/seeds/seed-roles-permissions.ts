/**
 * Idempotent seed — six platform roles + default permission sets + is_unscoped flags.
 * Run after migration 1700000800000. Re-running must not duplicate.
 * FR-AUD-011, design §8 seeds.
 *
 * Usage: import and call seedRolesPermissions(dataSource) from a NestJS lifecycle hook or CLI.
 */
import { DataSource } from 'typeorm';

type RoleSeed = {
  name: string;
  isUnscoped: boolean;
  approvalLimit: string | null;
  permissions: { module: string; action: string; projectScope: string }[];
};

const ALL_MODULES = ['AUD', 'NUM', 'PER', 'LED', 'MAS', 'SAL', 'PUR', 'REQ', 'INV', 'REC', 'HR', 'PAY', 'GEN', 'RPT', 'DSH', 'CC'];
const ADMIN_PERMS = ALL_MODULES.flatMap(m =>
  ['CREATE', 'READ', 'UPDATE', 'DELETE', 'POST', 'CANCEL', 'APPROVE', 'REJECT'].map(a => ({ module: m, action: a, projectScope: 'ALL' })),
);

const ROLE_SEEDS: RoleSeed[] = [
  {
    name: 'ADMIN',
    isUnscoped: true,
    approvalLimit: null,
    permissions: ADMIN_PERMS,
  },
  {
    name: 'ACCOUNTS_TEAM',
    isUnscoped: true,
    approvalLimit: null,
    permissions: [
      { module: 'LED', action: 'READ', projectScope: 'ALL' },
      { module: 'LED', action: 'CREATE', projectScope: 'ALL' },
      { module: 'LED', action: 'POST', projectScope: 'ALL' },
      // GEN (contra & journal vouchers) — docs/srs/14-contra-journal.md §3 Actors: "Accounts Team |
      // Creates, posts, and reverses contra and journal vouchers ... the primary user of this module."
      // (tier2-rbac-guard-wiring #36 — no GEN grant existed for any role before this brief.)
      { module: 'GEN', action: 'CREATE', projectScope: 'ALL' },
      { module: 'GEN', action: 'READ', projectScope: 'ALL' },
      { module: 'GEN', action: 'UPDATE', projectScope: 'ALL' },
      { module: 'GEN', action: 'DELETE', projectScope: 'ALL' },
      { module: 'GEN', action: 'POST', projectScope: 'ALL' },
      { module: 'GEN', action: 'CANCEL', projectScope: 'ALL' },
      { module: 'SAL', action: 'READ', projectScope: 'ALL' },
      // SAL write/post/cancel — docs/srs/10-sales-ipc.md §3 Actors: "Accounts Team | Creates, edits,
      // posts, prints, and (permissioned) cancels/corrects IPCs ..." (tier2-rbac-guard-wiring #36 — the
      // pre-existing seed only granted SAL:READ, so ACCOUNTS_TEAM could not create/post/cancel an IPC).
      { module: 'SAL', action: 'CREATE', projectScope: 'ALL' },
      { module: 'SAL', action: 'UPDATE', projectScope: 'ALL' },
      { module: 'SAL', action: 'DELETE', projectScope: 'ALL' },
      { module: 'SAL', action: 'POST', projectScope: 'ALL' },
      { module: 'SAL', action: 'CANCEL', projectScope: 'ALL' },
      { module: 'PUR', action: 'READ', projectScope: 'ALL' },
      // PUR write/post/cancel — docs/srs/08-purchase.md §3 Actors: "Accounts Team | Creates, edits, posts,
      // and (permissioned) cancels/corrects purchase bills; configures supplier-bill tax; reviews per-bill
      // outstanding and supplier payables." (purchase-po-bill-posting — the pre-existing seed only granted
      // PUR:READ, so ACCOUNTS_TEAM could not create/update/delete/post/cancel a purchase bill, despite
      // being this module's primary named actor for the full bill lifecycle.)
      { module: 'PUR', action: 'CREATE', projectScope: 'ALL' },
      { module: 'PUR', action: 'UPDATE', projectScope: 'ALL' },
      { module: 'PUR', action: 'DELETE', projectScope: 'ALL' },
      { module: 'PUR', action: 'POST', projectScope: 'ALL' },
      { module: 'PUR', action: 'CANCEL', projectScope: 'ALL' },
      { module: 'PAY', action: 'CREATE', projectScope: 'ALL' },
      { module: 'PAY', action: 'POST', projectScope: 'ALL' },
      { module: 'REC', action: 'CREATE', projectScope: 'ALL' },
      { module: 'REC', action: 'POST', projectScope: 'ALL' },
      // REC read/update/delete/cancel — docs/srs/11-receipts.md §3 Actors: "Accounts Team | Creates,
      // edits, posts, prints, and (permissioned) cancels/corrects receipts; selects the IPC an IPC-linked
      // receipt settles; records general receipts; reviews per-IPC balance due after a receipt." (receipts-
      // voucher-core #24 — the pre-existing seed only granted REC:CREATE/POST, so ACCOUNTS_TEAM could not
      // read/edit/delete a draft receipt or cancel/repost a posted one, despite being this module's
      // primary named actor for the full lifecycle.)
      { module: 'REC', action: 'READ', projectScope: 'ALL' },
      { module: 'REC', action: 'UPDATE', projectScope: 'ALL' },
      { module: 'REC', action: 'DELETE', projectScope: 'ALL' },
      { module: 'REC', action: 'CANCEL', projectScope: 'ALL' },
      { module: 'RPT', action: 'READ', projectScope: 'ALL' },
      { module: 'MAS', action: 'READ', projectScope: 'ALL' },
      { module: 'CC', action: 'READ', projectScope: 'ALL' },
    ],
  },
  {
    name: 'PROJECT_MANAGER',
    isUnscoped: false,
    approvalLimit: null,
    permissions: [
      { module: 'MAS', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'MAS', action: 'UPDATE', projectScope: 'ASSIGNED' },
      { module: 'SAL', action: 'CREATE', projectScope: 'ASSIGNED' },
      { module: 'SAL', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'PUR', action: 'CREATE', projectScope: 'ASSIGNED' },
      { module: 'PUR', action: 'READ', projectScope: 'ASSIGNED' },
      // PUR approve (PO approval) — docs/srs/08-purchase.md §3 Actors: "Project Manager | Raises /
      // approves purchase orders for assigned projects; sees the entry-time over-budget warning; reviews
      // committed-vs-actual procurement spend for a project." (purchase-po-bill-posting — the pre-existing
      // seed granted PM only PUR:CREATE/READ, so the PO `…/approve` route was unreachable for its own
      // named actor. Store Keeper is intentionally granted NOTHING for PUR — GRN, their action, is the
      // next brief.)
      { module: 'PUR', action: 'APPROVE', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'CREATE', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'APPROVE', projectScope: 'ASSIGNED' },
      // REQ update/delete (edit/delete own DRAFT + submit/close) — docs/srs/09-requisition.md §7 Flow A
      // step 1: "A PM / Site Engineer creates a DRAFT requisition..."; FR-REQ-022: "a requisition shall
      // be editable/deletable only while DRAFT" (the requester — PM per creation — is implied); FR-REQ-006:
      // "The requester shall submit a DRAFT requisition for review." (tier2-rbac-guard-wiring #36 — PM
      // held REQ:CREATE/READ/APPROVE only, so PATCH/DELETE/submit/close on PM's own draft requisitions
      // were unreachable for the module's own named requester.)
      { module: 'REQ', action: 'UPDATE', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'DELETE', projectScope: 'ASSIGNED' },
      // REQ reject — docs/srs/09-requisition.md §3 Actors: "Project Manager | ... approves requisitions
      // within the PM tier threshold ..." and FR-REQ-008 / §7 Flow B: "The authorised approver (PM within
      // the tier, or Accounts above it) ... approves ... or rejects with a reason." Reject is the same
      // authorised-approver action as approve, just the other outcome — PM needed both (tier2-rbac-guard-
      // wiring #36 — PM held REQ:APPROVE but not REQ:REJECT before this brief).
      { module: 'REQ', action: 'REJECT', projectScope: 'ASSIGNED' },
      // INV approve — docs/srs/07-inventory.md §3 Actors: "Project Manager | Approves Stock Journals
      // for assigned projects; reviews stock balances/valuation per project." (tier2-rbac-guard-wiring
      // #36 — PM held zero INV grant before this brief, so the stock-journal `:id/approve` route was
      // unreachable for its own named actor.)
      { module: 'INV', action: 'APPROVE', projectScope: 'ASSIGNED' },
      { module: 'HR', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'CC', action: 'READ', projectScope: 'ASSIGNED' },
      // REC read — docs/srs/11-receipts.md §3 Actors: "Project Manager | Reads receipts and the resulting
      // per-IPC outstanding for assigned projects (collection visibility); does not post receipts."
      // (receipts-voucher-core #24 — PM held zero REC grant before this brief, so project-scoped receipt
      // visibility was unreachable for its own named read-only actor.)
      { module: 'REC', action: 'READ', projectScope: 'ASSIGNED' },
    ],
  },
  {
    name: 'SITE_ENGINEER',
    isUnscoped: false,
    approvalLimit: null,
    permissions: [
      { module: 'MAS', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'CREATE', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'HR', action: 'CREATE', projectScope: 'ASSIGNED' },
      { module: 'HR', action: 'READ', projectScope: 'ASSIGNED' },
    ],
  },
  {
    name: 'STORE_KEEPER',
    isUnscoped: false,
    approvalLimit: null,
    permissions: [
      { module: 'MAS', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'INV', action: 'CREATE', projectScope: 'ASSIGNED' },
      { module: 'INV', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'INV', action: 'UPDATE', projectScope: 'ASSIGNED' },
      // INV post/cancel — docs/srs/07-inventory.md §3 Actors: "Store Keeper | Records Stock Journals
      // (transfers, issues, adjustments) ... the primary day-to-day INV user" and §7 Flow A/B: "Store
      // Keeper posts ..." / "Store Keeper (or the REQ issue flow)". §7 Flow D names Accounts/PM
      // (permissioned) for reversal too, but Store Keeper is the day-to-day poster and needed CANCEL to
      // correct their own draft-stage mistakes without an Accounts/PM escalation for every case — kept
      // minimal here to what the route table needs (tier2-rbac-guard-wiring #36 — Store Keeper held no
      // POST/CANCEL grant before this brief, so the stock-journal post/reverse routes were unreachable).
      { module: 'INV', action: 'POST', projectScope: 'ASSIGNED' },
      { module: 'INV', action: 'CANCEL', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'READ', projectScope: 'ASSIGNED' },
      // REQ post/cancel (issue + reverse-an-issue) — docs/srs/09-requisition.md §3 Actors: "Store Keeper |
      // Issues an approved requisition (full or partial) from the project godown; the issue is what moves
      // stock and posts consumption." and §7 Flow C step 1: "The Store Keeper opens an APPROVED/
      // PARTIALLY_ISSUED requisition and enters, per line, an issue_quantity ...". Flow E names
      // Accounts/PM (permissioned) as the one who *requests* a reversal, but the Store Keeper is this
      // module's own named issuer and needed CANCEL to correct their own issue mistakes without an
      // Accounts/PM escalation for every case — kept minimal here to what the route table needs, mirroring
      // the exact `STORE_KEEPER: INV:POST/CANCEL` precedent above (same actor, same style;
      // requisition-issue-posting #23 — Store Keeper held REQ:READ only before this brief, so the
      // `…/issue` and `…/issues/:issueId/reverse` routes were unreachable for its own named actor).
      { module: 'REQ', action: 'POST', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'CANCEL', projectScope: 'ASSIGNED' },
    ],
  },
  {
    name: 'HR_MANAGER',
    isUnscoped: false,
    approvalLimit: null,
    permissions: [
      { module: 'HR', action: 'CREATE', projectScope: 'ASSIGNED' },
      { module: 'HR', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'HR', action: 'UPDATE', projectScope: 'ASSIGNED' },
      // HR confirm/reverse (daily-labour accrual) — docs/srs/12-hr-payroll.md §3 Actors: "HR Manager |
      // Maintains the employee master; reviews and confirms attendance; generates, reviews, and posts
      // salary sheets ..." and §7.C step 3: "HR Manager/Accounts confirms the entry." (tier2-rbac-guard-
      // wiring #36 — HR_MANAGER held no POST/CANCEL grant before this brief, so daily-labour confirm/
      // reverse were unreachable for its own named actor.)
      { module: 'HR', action: 'POST', projectScope: 'ASSIGNED' },
      { module: 'HR', action: 'CANCEL', projectScope: 'ASSIGNED' },
      { module: 'PAY', action: 'READ', projectScope: 'ASSIGNED' },
    ],
  },
];

export async function seedRolesPermissions(dataSource: DataSource, companyId: string): Promise<void> {
  for (const seed of ROLE_SEEDS) {
    // Upsert role
    const existing = await dataSource.query(
      `SELECT id FROM "role" WHERE company_id = $1 AND name = $2`,
      [companyId, seed.name],
    );
    let roleId: string;
    if (existing.length > 0) {
      roleId = existing[0].id;
      await dataSource.query(
        `UPDATE "role" SET is_unscoped = $1, approval_limit = $2 WHERE id = $3`,
        [seed.isUnscoped, seed.approvalLimit, roleId],
      );
    } else {
      roleId = crypto.randomUUID();
      await dataSource.query(
        `INSERT INTO "role" (id, company_id, name, is_unscoped, approval_limit, version)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [roleId, companyId, seed.name, seed.isUnscoped, seed.approvalLimit],
      );
    }

    // Idempotent permissions: insert only if missing
    for (const perm of seed.permissions) {
      const existingPerm = await dataSource.query(
        `SELECT id FROM "permission" WHERE role_id = $1 AND module = $2 AND action = $3`,
        [roleId, perm.module, perm.action],
      );
      if (existingPerm.length === 0) {
        await dataSource.query(
          `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version)
           VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [crypto.randomUUID(), roleId, companyId, perm.module, perm.action, perm.projectScope],
        );
      }
    }
  }
}
