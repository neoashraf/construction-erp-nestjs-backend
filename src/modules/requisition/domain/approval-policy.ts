/**
 * approval-policy (PURE — Decimal only, no NestJS/TypeORM). The ONLY place the requisition tiering rule
 * lives, so the escalate-by-default boundary cases are unit-testable without any I/O (design §2.2).
 *
 *   - `selectTier(estimatedValue, pmThreshold)` — at or below the PM threshold → `PM` may approve; above
 *     → escalate to `ACCOUNTS` (FR-REQ-009). Exact Decimal, never float.
 *   - `canApprove(selectedTier, approver)` — escalate-by-default: an approver may approve ONLY if their
 *     tier matches the requisition's selected tier AND (for the PM tier) they are assigned to the project.
 *     An undefined/exceeded per-role limit grants NO authority; a PM can never approve an ACCOUNTS-tier
 *     (escalated) requisition (FR-REQ-010/-011; overview §10).
 */
import Decimal from 'decimal.js';
import { ApprovalTier } from './requisition-status';

/** The approver's context for the authority check. */
export interface ApproverContext {
  /** The tier the approver acts in — `PM` for a Project Manager, `ACCOUNTS` for the escalation authority. */
  tier: ApprovalTier;
  /** Whether the (PM) approver is assigned to the requisition's project (F4). Irrelevant for ACCOUNTS. */
  assignedToProject: boolean;
}

/** At or below the threshold → PM tier; above → escalate to ACCOUNTS (FR-REQ-009). */
export function selectTier(estimatedValue: Decimal, pmThreshold: Decimal): ApprovalTier {
  return estimatedValue.lessThanOrEqualTo(pmThreshold) ? 'PM' : 'ACCOUNTS';
}

/** Escalate-by-default authority check (FR-REQ-010/-011). */
export function canApprove(selectedTier: ApprovalTier, approver: ApproverContext): boolean {
  if (selectedTier === 'PM') {
    return approver.tier === 'PM' && approver.assignedToProject;
  }
  // ACCOUNTS-tier (escalated) — only the ACCOUNTS authority may approve; a PM never can.
  return approver.tier === 'ACCOUNTS';
}
