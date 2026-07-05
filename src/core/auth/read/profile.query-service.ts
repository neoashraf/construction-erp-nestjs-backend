/**
 * ProfileQueryService (AUD read/ — FR-AUD-029/030). Backs GET /api/profile and the refreshed view
 * returned by PATCH /api/profile + the avatar endpoints: a live, self-scoped projection of the caller's
 * own identity + role + avatar + assigned projects + version.
 *
 * No writes, no transaction. It OMITS effective permissions (those are the session read's concern,
 * GET /api/auth/me) and never exposes password_hash or avatar_public_id (FR-AUD-002/010/043).
 * Company-scoped from the token; a deactivated/unknown caller is FORBIDDEN (FR-AUD-009/027/036).
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { Actor } from '../../tenancy/tenant-context';
import { ProfileView, AssignedProjectsDto } from './dto/profile-view.dto';

@Injectable()
export class ProfileQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  /** The caller's own profile projection (identity from the token, not a lookup param). */
  async getProfile(actor: Actor): Promise<ProfileView> {
    const [userRow] = await this.ds.query(
      `SELECT id, email, name, phone, avatar_url AS "avatarUrl", role,
              financial_year_id AS "financialYearId", is_active AS "isActive",
              last_login_at AS "lastLoginAt", version
       FROM "user" WHERE id = $1 AND company_id = $2`,
      [actor.userId, actor.companyId],
    );
    if (!userRow || userRow.isActive === false) throw new ForbiddenException('FORBIDDEN');

    const [roleRow] = await this.ds.query(
      `SELECT is_unscoped AS "isUnscoped" FROM "role" WHERE name = $1 AND company_id = $2`,
      [userRow.role, actor.companyId],
    );
    const isUnscoped = roleRow?.isUnscoped ?? false;

    let assignedProjects: AssignedProjectsDto;
    if (isUnscoped) {
      assignedProjects = { scope: 'ALL' };
    } else {
      const rows = await this.ds.query(
        `SELECT p.id AS "projectId", p.name AS "projectName"
         FROM user_project up JOIN project p ON p.id = up.project_id
         WHERE up.user_id = $1 AND p.company_id = $2
         ORDER BY p.name`,
        [actor.userId, actor.companyId],
      );
      assignedProjects = rows.map((r: any) => ({ projectId: r.projectId, projectName: r.projectName }));
    }

    return {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      phone: userRow.phone ?? null,
      avatarUrl: userRow.avatarUrl ?? null,
      role: userRow.role,
      isUnscoped,
      isActive: userRow.isActive,
      financialYearId: userRow.financialYearId,
      lastLoginAt: userRow.lastLoginAt ? new Date(userRow.lastLoginAt).toISOString() : null,
      assignedProjects,
      version: userRow.version,
    };
  }
}
