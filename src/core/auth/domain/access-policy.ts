/**
 * AccessPolicy (AUD application, FR-AUD-014/015/016/017). PURE TypeScript; no NestJS/TypeORM.
 * Service-layer enforcement: project scope + approval-limit. Injected into every use case that
 * reads or writes project-bound data so cross-module calls cannot bypass these checks (design §5.1).
 */
import Decimal from 'decimal.js';
import { Actor } from '../../tenancy/tenant-context';

/** Raised when the actor's role has no authority to approve this value (FR-AUD-016). */
export class OverApprovalLimitError extends Error {
  constructor(
    readonly actorId: string,
    readonly value: Decimal,
    readonly limit: Decimal | null,
  ) {
    super(`OVER_APPROVAL_LIMIT: value ${value.toFixed(4)} exceeds limit ${limit?.toFixed(4) ?? 'null'}`);
    this.name = 'OverApprovalLimitError';
  }
}

/** Raised when the actor's project scope excludes the requested project (FR-AUD-014). */
export class ForbiddenScopeError extends Error {
  constructor(readonly actorId: string, readonly projectId: string) {
    super(`FORBIDDEN_SCOPE: actor ${actorId} has no access to project ${projectId}`);
    this.name = 'ForbiddenScopeError';
  }
}

export class AccessPolicy {
  /**
   * Asserts the actor may read/write the given project.
   * Unscoped actors (Admin, Accounts Team) always pass.
   * Scoped actors pass only if projectId ∈ assignedProjectIds.
   * FR-AUD-014, edge case 3.
   */
  assertProjectInScope(actor: Actor, projectId: string): void {
    if (actor.isUnscoped) return;
    if (!(actor.assignedProjectIds ?? []).includes(projectId)) {
      throw new ForbiddenScopeError(actor.userId, projectId);
    }
  }

  /**
   * Returns a filter to scope list queries to the actor's assigned projects.
   * Unscoped actors get 'ALL' (no filter); scoped actors get their assigned ids.
   * A scoped user with zero assignments gets an empty array → reads empty.
   * FR-AUD-014/015, edge case 14.
   */
  scopeProjectFilter(actor: Actor): { projectIds: string[] } | 'ALL' {
    if (actor.isUnscoped) return 'ALL';
    return { projectIds: [...(actor.assignedProjectIds ?? [])] };
  }

  /**
   * Asserts the actor's approval limit is not exceeded.
   * null approvalLimit = no approval authority → every value escalates (design §10).
   * FR-AUD-016, edge case 9.
   */
  assertWithinApprovalLimit(actor: Actor, value: Decimal): void {
    const limit = actor.approvalLimit ?? null;
    if (limit === null || value.greaterThan(limit)) {
      throw new OverApprovalLimitError(actor.userId, value, limit);
    }
  }
}
