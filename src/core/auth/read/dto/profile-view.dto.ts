/**
 * ProfileView DTO (AUD read/ — FR-AUD-029/030). The caller's own account-screen projection returned by
 * GET /api/profile and by a successful PATCH /api/profile / avatar change. camelCase JSON.
 *
 * Deliberately carries NO `permissions` field — the effective grant set is the session read's concern
 * (GET /api/auth/me). Never includes password_hash or avatar_public_id (FR-AUD-043).
 */

export type AssignedProjectsDto =
  | { scope: 'ALL' }
  | Array<{ projectId: string; projectName: string }>;

export interface ProfileView {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  /** Cloudinary served URL of the profile photo; null when none. The public id is never projected. */
  avatarUrl: string | null;
  role: string;
  isUnscoped: boolean;
  isActive: boolean;
  financialYearId: string;
  lastLoginAt: string | null;
  /** `{ scope: 'ALL' }` for an unscoped role, else the assigned `{ projectId, projectName }[]`. */
  assignedProjects: AssignedProjectsDto;
  /** The User optimistic-lock version, echoed for the self-update. */
  version: number;
}
