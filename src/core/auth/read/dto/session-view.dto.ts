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
