/**
 * ReportScopeService (RPT · FR-RPT-006/-007 — AUD F3/F4) — application. Resolves the effective company +
 * project filter EVERY report query runs under, mirroring the LED/PUR read-side scoping:
 *   - company is always the caller's (F3) — never a parameter;
 *   - an UNSCOPED user (Accounts / Admin) sees all projects (`projectIds = null`), or the single explicit
 *     `projectId` when one is supplied;
 *   - a PROJECT-SCOPED user (PM) with no `projectId` is auto-filtered to their assigned projects
 *     (`projectIds = assignedProjectIds`) — a PM with no assignments gets an empty scope `[]` → a valid
 *     empty report, not all projects (SRS edge case 2);
 *   - a PM filtering an EXPLICIT unassigned `projectId` is `403 FORBIDDEN`, never a silent empty result
 *     (FR-RPT-007; SRS edge case 1).
 * Role visibility (which reports a role may run at all, FR-RPT-008) is enforced upstream by the RolesGuard
 * (`@Roles({ module:'RPT', action:'READ' })`); this service enforces the project boundary.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { Actor } from '../../core/tenancy/tenant-context';

export interface ResolvedProjectScope {
  companyId: string;
  /** `null` = all projects; `[]` = none (empty report); `[ids]` = restricted. */
  projectIds: string[] | null;
}

@Injectable()
export class ReportScopeService {
  resolve(actor: Actor, projectId?: string): ResolvedProjectScope {
    if (actor.isUnscoped) {
      return { companyId: actor.companyId, projectIds: projectId ? [projectId] : null };
    }
    if (projectId) {
      if (!actor.assignedProjectIds.includes(projectId)) {
        throw new ForbiddenException('Project not assigned to this user');
      }
      return { companyId: actor.companyId, projectIds: [projectId] };
    }
    // PM with no explicit project → auto-filter to assigned projects ([] → valid empty report).
    return { companyId: actor.companyId, projectIds: [...actor.assignedProjectIds] };
  }
}
