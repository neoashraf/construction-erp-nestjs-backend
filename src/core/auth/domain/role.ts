/** Platform roles — AUD §5.2 (FR-AUD-011). Single role per user in Phase 1. */
export const ROLE_NAMES = [
  'ADMIN',
  'PROJECT_MANAGER',
  'SITE_ENGINEER',
  'STORE_KEEPER',
  'ACCOUNTS_TEAM',
  'HR_MANAGER',
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export function assertRoleName(v: string): RoleName {
  if (!(ROLE_NAMES as readonly string[]).includes(v)) {
    throw new Error(`Invalid role: ${v}`);
  }
  return v as RoleName;
}
