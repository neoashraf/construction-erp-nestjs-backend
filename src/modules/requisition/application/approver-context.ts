/**
 * approverContext (application helper, PURE) — derives the approval-policy's ApproverContext from an Actor.
 * The AUD Phase-1 rule: a SCOPED actor (Project Manager) acts in the PM tier and may approve only its
 * assigned projects; an UNSCOPED actor (Accounts Team / Admin) is the escalation authority and acts in the
 * ACCOUNTS tier (FR-REQ-009/-011; overview §10). Escalate-by-default is enforced by `canApprove`, not here.
 */
import { Actor } from '../../../core/tenancy/tenant-context';
import { ApproverContext } from '../domain/approval-policy';

export function approverContextOf(actor: Actor, projectId: string): ApproverContext {
  if (actor.isUnscoped) {
    return { tier: 'ACCOUNTS', assignedToProject: true };
  }
  return { tier: 'PM', assignedToProject: actor.assignedProjectIds.includes(projectId) };
}
