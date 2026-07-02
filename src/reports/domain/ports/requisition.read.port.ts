/**
 * RequisitionReadPort (RPT · FR-RPT-024) — PURE domain port. The seam to REQ's requisition/issue read
 * surface. The adapter runs a scoped SELECT over `requisition` ⋈ `requisition_line` (REQ maintains the
 * denormalised `requested_quantity` / `issued_quantity` per line). RPT reads REQ's figures and derives the
 * variance (`requested − issued`) in the query service — the arithmetic is not an owned figure. Company is
 * always on the query (F3); a project-scoped user's assigned-projects filter is applied (F4).
 */
import { PaginatedRows } from './ledger.read.port';

export const REQUISITION_READ_PORT = Symbol('REQUISITION_READ_PORT');

export interface RequisitionScope {
  companyId: string;
  /** F4 project filter: null = all; [] = none (valid empty report); [ids] = restricted. */
  projectIds: string[] | null;
  costCentreId?: string;
  requisitionId?: string;
  financialYearId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

/** REQ's raw per-line figures — the query service derives `varianceQty = requestedQty − issuedQty`. */
export interface RequisitionIssueReadRow {
  requisitionId: string;
  projectId: string | null;
  costCentreId: string | null;
  itemId: string;
  requestedQty: string;
  issuedQty: string;
}

export interface RequisitionReadPort {
  /** Per requisition line: the requested and issued quantities (REQ's projection) (FR-RPT-024). */
  requisitionVsIssue(scope: RequisitionScope): Promise<PaginatedRows<RequisitionIssueReadRow>>;
}
