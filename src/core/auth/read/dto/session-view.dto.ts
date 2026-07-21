/**
 * SessionView DTOs (AUD read/ — FR-AUD-031/032/033). The caller's own session projection returned by
 * GET /api/auth/me. camelCase JSON; money (approvalLimit/valueLimit) as Decimal(18,4) strings, never
 * float; never includes password_hash or encrypted-at-rest fields.
 */

export interface SessionUserDto {
  id: string;
  email: string;
  name: string;
  role: string;
  companyId: string;
  financialYearId: string;
  isActive: boolean;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  /** Cloudinary served URL of the profile photo; null when none (AUD profile slice, FR-AUD-039). */
  avatarUrl: string | null;
  /** Display name of the user's company — shell chip / profile; null if unresolved. */
  companyName: string | null;
  /** Label of the user's default financial year (e.g. "FY 2025-26"); null if unresolved. */
  financialYearLabel: string | null;
}

export type ProjectScopeDto =
  | { scope: 'ALL' }
  | { scope: 'ASSIGNED'; projectIds: string[] };

export interface SessionPermissionDto {
  resource: string;
  action: string;
  projectScope: 'ALL' | 'ASSIGNED';
  valueLimit: string | null;
}

export interface SessionView {
  user: SessionUserDto;
  projectScope: ProjectScopeDto;
  approvalLimit: string | null;
  permissions: SessionPermissionDto[];
}
