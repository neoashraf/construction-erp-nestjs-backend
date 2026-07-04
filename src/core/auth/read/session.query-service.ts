/**
 * SessionQueryService (AUD read/ — FR-AUD-031/032/033). Backs GET /api/auth/me: a LIVE read-model
 * projection of the caller's OWN identity + effective resource-level grants + project scope + approval
 * limit + mustChangePassword. No writes, no transaction, no `session`/`effective_permission` table —
 * computed straight from the caller's Role→Permission rows + user_project, so an Admin edit reflects on
 * the next call with no re-login (FR-AUD-033). Company-scoped from the token (FR-AUD-027); password_hash
 * and encrypted-at-rest fields never enter the projection (FR-AUD-002/010).
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { Actor } from '../../tenancy/tenant-context';
import { SessionView, ProjectScopeDto, SessionPermissionDto } from './dto/session-view.dto';

@Injectable()
export class SessionQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  /** The caller's own session projection (identity from the token, not a lookup param). */
  async me(actor: Actor): Promise<SessionView> {
    const [userRow] = await this.ds.query(
      `SELECT id, email, name, role, company_id AS "companyId", financial_year_id AS "financialYearId",
              is_active AS "isActive", last_login_at AS "lastLoginAt", must_change_password AS "mustChangePassword"
       FROM "user" WHERE id = $1 AND company_id = $2`,
      [actor.userId, actor.companyId],
    );
    // The caller is deactivated/unknown for this company — treat as no session (FR-AUD-009/027).
    if (!userRow || userRow.isActive === false) throw new ForbiddenException('FORBIDDEN');

    const [roleRow] = await this.ds.query(
      `SELECT id, is_unscoped AS "isUnscoped", approval_limit::text AS "approvalLimit"
       FROM "role" WHERE name = $1 AND company_id = $2`,
      [userRow.role, actor.companyId],
    );

    const permissions: SessionPermissionDto[] = roleRow
      ? (
          await this.ds.query(
            `SELECT resource, action, project_scope AS "projectScope", value_limit::text AS "valueLimit"
             FROM "permission" WHERE role_id = $1 AND company_id = $2 ORDER BY resource, action`,
            [roleRow.id, actor.companyId],
          )
        ).map((p: any) => ({ resource: p.resource, action: p.action, projectScope: p.projectScope, valueLimit: p.valueLimit ?? null }))
      : [];

    let projectScope: ProjectScopeDto;
    if (roleRow?.isUnscoped) {
      projectScope = { scope: 'ALL' };
    } else {
      const rows = await this.ds.query(
        `SELECT project_id AS "projectId" FROM user_project WHERE user_id = $1`,
        [actor.userId],
      );
      projectScope = { scope: 'ASSIGNED', projectIds: rows.map((r: any) => r.projectId) };
    }

    return {
      user: {
        id: userRow.id,
        email: userRow.email,
        name: userRow.name,
        role: userRow.role,
        companyId: userRow.companyId,
        financialYearId: userRow.financialYearId,
        isActive: userRow.isActive,
        lastLoginAt: userRow.lastLoginAt ? new Date(userRow.lastLoginAt).toISOString() : null,
        mustChangePassword: userRow.mustChangePassword,
      },
      projectScope,
      approvalLimit: roleRow?.approvalLimit ?? null,
      permissions,
    };
  }
}
