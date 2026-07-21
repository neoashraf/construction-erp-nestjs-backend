/**
 * ProjectManagerAssignmentService (MAS application) — keeps the named project manager's
 * project-visibility in sync with `project.project_manager_id`.
 *
 * WHY: a project-scoped role (PROJECT_MANAGER, SITE_ENGINEER, STORE_KEEPER) only sees the
 * projects it is assigned to via `user_project` — that join is the session projectScope
 * (FR-AUD-031, SessionQueryService). Naming a user as a project's manager does NOT grant
 * that visibility on its own, so the assigned PM couldn't see (or work on) the project they
 * manage. This service mirrors the assignment: on project create — and whenever the PM
 * changes on update — it ensures a `user_project` row exists so the PM sees the project on
 * their next `/api/auth/me` (i.e. next login), across every project-scoped screen.
 *
 * Idempotent and defensive:
 *   - Unscoped roles (Admin, Accounts, HR) already see every project — no row is written
 *     for them (mirrors the ROLE_SCOPE_CONFLICT rule in UserProjectUseCases.replaceProjects).
 *   - A projectManagerId that doesn't resolve to a company user is skipped (the FK /
 *     cross-company validation for project_manager_id is a separate seam — see the NOTE in
 *     project.use-cases).
 *   - An already-assigned (user, project) pair is left untouched.
 *
 * Call INSIDE the project write's UnitOfWork so the assignment commits atomically with the
 * project (uses the shared transaction manager, like every other MAS repository).
 */
import { Inject, Injectable } from '@nestjs/common';
import { UserProjectAssignment } from '../../../../core/auth/domain/user-project-assignment.entity';
import {
  UserProjectAssignmentRepository,
  USER_PROJECT_ASSIGNMENT_REPOSITORY,
} from '../../../../core/auth/domain/ports/user-project-assignment.repository.port';
import { UserRepository, USER_REPOSITORY } from '../../../../core/auth/domain/ports/user.repository.port';
import { RoleRepository, ROLE_REPOSITORY } from '../../../../core/auth/domain/ports/role.repository.port';
import { AUDIT_SERVICE, AuditService } from '../../../../core/audit/application/audit.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { CLOCK, Clock } from '../../../../common/ports/clock.port';
import { Actor } from '../../../../core/tenancy/tenant-context';

@Injectable()
export class ProjectManagerAssignmentService {
  constructor(
    @Inject(USER_PROJECT_ASSIGNMENT_REPOSITORY) private readonly assignments: UserProjectAssignmentRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Ensure the named project manager can see the project. No-op when the user is unscoped,
   * unknown to this company, or already assigned. Audited (CREATE UserProjectAssignment)
   * only when a new row is actually written.
   */
  async ensureAssigned(projectManagerId: string, projectId: string, actor: Actor): Promise<void> {
    const user = await this.users.findById(projectManagerId);
    if (!user || user.props.companyId !== actor.companyId) return;

    const role = await this.roles.findByName(actor.companyId, user.props.role);
    if (role?.props.isUnscoped) return; // unscoped roles already see every project

    const existing = await this.assignments.findByUserAndProject(projectManagerId, projectId);
    if (existing) return;

    const assignment = UserProjectAssignment.create(this.ids.next(), {
      userId: projectManagerId,
      projectId,
      companyId: actor.companyId,
      assignedAt: this.clock.now(),
    });
    await this.assignments.save(assignment);
    await this.audit.record({
      action: 'CREATE',
      entityType: 'UserProjectAssignment',
      entityId: `${projectManagerId}:${projectId}`,
      actorId: actor.userId,
      companyId: actor.companyId,
      before: null,
      after: { userId: projectManagerId, projectId, via: 'ProjectManagerAssigned' },
    });
  }
}
