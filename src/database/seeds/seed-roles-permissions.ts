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
      { module: 'SAL', action: 'READ', projectScope: 'ALL' },
      { module: 'PUR', action: 'READ', projectScope: 'ALL' },
      { module: 'PAY', action: 'CREATE', projectScope: 'ALL' },
      { module: 'PAY', action: 'POST', projectScope: 'ALL' },
      { module: 'REC', action: 'CREATE', projectScope: 'ALL' },
      { module: 'REC', action: 'POST', projectScope: 'ALL' },
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
      { module: 'REQ', action: 'CREATE', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'REQ', action: 'APPROVE', projectScope: 'ASSIGNED' },
      { module: 'HR', action: 'READ', projectScope: 'ASSIGNED' },
      { module: 'CC', action: 'READ', projectScope: 'ASSIGNED' },
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
      { module: 'REQ', action: 'READ', projectScope: 'ASSIGNED' },
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
