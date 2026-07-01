/**
 * Requisition status + the legal workflow transitions (PURE — no NestJS/TypeORM). REQ is a workflow
 * document with the lifecycle `DRAFT → SUBMITTED → APPROVED/REJECTED → PARTIALLY_ISSUED → ISSUED/CLOSED`
 * (design §3). This file owns the status value-set and the legality of each move; the aggregate enforces
 * it. The ISSUED / PARTIALLY_ISSUED transitions are reached only by brief 2's issue — this brief builds
 * the workflow half (create/submit/approve/reject/close), leaving the issue seam for #23.
 */

export type RequisitionStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'PARTIALLY_ISSUED'
  | 'ISSUED'
  | 'CLOSED';

export const REQUISITION_STATUSES: readonly RequisitionStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'PARTIALLY_ISSUED',
  'ISSUED',
  'CLOSED',
] as const;

export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export const PRIORITIES: readonly Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

export type ApprovalTier = 'PM' | 'ACCOUNTS';
export const APPROVAL_TIERS: readonly ApprovalTier[] = ['PM', 'ACCOUNTS'] as const;

export type ApprovalDecision = 'APPROVED' | 'REJECTED';
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ['APPROVED', 'REJECTED'] as const;

/** Statuses that still hold an outstanding balance and may be manually closed (FR-REQ-020). */
export const CLOSABLE_STATUSES: readonly RequisitionStatus[] = ['APPROVED', 'PARTIALLY_ISSUED'] as const;

/** Statuses from which the Store Keeper may issue against the requisition (FR-REQ-012). */
export const ISSUABLE_STATUSES: readonly RequisitionStatus[] = ['APPROVED', 'PARTIALLY_ISSUED'] as const;
