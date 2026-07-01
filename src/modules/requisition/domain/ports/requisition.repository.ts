/**
 * RequisitionRepository port (REQ-owned, driven). PURE interface — the application depends on this, the
 * TypeORM adapter implements it. Persists/loads the Requisition aggregate (header + lines + approvals);
 * `findByIdForUpdate` row-locks the requisition inside a mutating UoW (anti-double-submit/approve). Brief
 * #23 (requisition-issue-posting) adds:
 *   - `findLineForUpdate` — `SELECT … FOR UPDATE` on ONE `requisition_line` row (the second of the two-lock
 *     scheme, design §5.4 — anti-over-issue on that specific line, independent of the header lock);
 *   - `saveIssue` / `findIssue` / `listIssues` — persist/read `RequisitionIssue` (+lines) rows, append-only.
 * Every method is companyId-scoped (F3).
 */
import { Requisition } from '../requisition';
import { RequisitionIssue } from '../requisition-issue';

export interface RequisitionLineForUpdate {
  id: string;
  requisitionId: string;
  itemId: string;
  balanceQuantity: import('decimal.js').default;
}

export interface RequisitionRepository {
  insert(req: Requisition): Promise<void>;
  save(req: Requisition, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<Requisition | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<Requisition | null>;
  softDelete(id: string, companyId: string): Promise<void>;
  /** Next per-company + FY requisition sequence (a simple, non-gapless reference — SRS §16). */
  nextRequisitionSeq(companyId: string, financialYearId: string): Promise<number>;

  /**
   * `SELECT … FOR UPDATE` on ONE requisition_line row (design §5.4 — the line-balance lock, anti-over-
   * issue). Returns null if the line doesn't exist or belongs to a different company (via its parent
   * requisition). MUST be called inside a UnitOfWork.
   */
  findLineForUpdate(lineId: string, companyId: string): Promise<RequisitionLineForUpdate | null>;

  /** Persist a new RequisitionIssue (+its lines) — append-only insert, never an update. */
  saveIssue(issue: RequisitionIssue): Promise<void>;

  /** Persist a reversal mark on an existing issue (reversedAt/reversedById only — append-only). */
  saveIssueReversal(issue: RequisitionIssue): Promise<void>;

  /** Load one issue (+lines) by id, scoped to its parent requisition + company. */
  findIssue(requisitionId: string, issueId: string, companyId: string): Promise<RequisitionIssue | null>;

  /** All issues (+lines) for a requisition, chronological (issueNo ascending). */
  listIssues(requisitionId: string, companyId: string): Promise<RequisitionIssue[]>;

  /** Next per-requisition issue sequence (1, 2, … for partial issues — SRS §8 `issue_no`). */
  nextIssueNo(requisitionId: string): Promise<number>;
}

export const REQUISITION_REPOSITORY = Symbol('RequisitionRepository');
