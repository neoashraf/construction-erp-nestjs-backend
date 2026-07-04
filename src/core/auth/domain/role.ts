/**
 * Role names — AUD RBAC v2 (FR-AUD-011/034). A role `name` is now a free per-company-unique STRING
 * (Admin may create custom roles). Six protected built-ins (`is_system=true`) are seeded; the token
 * still carries exactly one `role` (single-role-per-user, Phase 1). `ACCOUNTS_TEAM` was renamed
 * `ACCOUNTS_MANAGER` in the RbacV2 migration.
 */
export const BUILTIN_ROLE_NAMES = [
  'ADMIN',
  'PROJECT_MANAGER',
  'SITE_ENGINEER',
  'STORE_KEEPER',
  'ACCOUNTS_MANAGER',
  'HR_MANAGER',
] as const;

export type BuiltinRoleName = (typeof BUILTIN_ROLE_NAMES)[number];

/** Role name is a free string (built-in or custom). */
export type RoleName = string;

export function isBuiltInRole(name: string): name is BuiltinRoleName {
  return (BUILTIN_ROLE_NAMES as readonly string[]).includes(name);
}
