/**
 * RequisitionMasterRefPort (driven; owner MAS). The master-reference validation REQ runs at draft
 * create/patch (never re-specifying MAS entities — it reads them):
 *   - the project is not CLOSED (FR-REQ-004, MAS FR-MAS-006);
 *   - the cost centre is an ACTIVE company cost centre (any active CC — no project restriction; FR-REQ-002);
 *   - the referenced from_godown (if set) is ACTIVE and belongs to the requisition's project (FR-REQ-003/-004);
 *   - each line's item is ACTIVE and its base UoM (the line's UoM — MAS) is resolvable (FR-REQ-004).
 * PURE interface; the MAS-reading adapter implements it. Cross-project purpose/godown is CC's
 * TagConsistencyService (separate port), not this one.
 */

export interface RequisitionMasterRefPort {
  /** Reject a CLOSED project (FR-REQ-004). */
  assertProjectNotClosed(companyId: string, projectId: string): Promise<void>;
  /** Reject a missing/inactive cost centre — any active company CC is valid (FR-REQ-002). */
  assertCostCentreActive(companyId: string, costCentreId: string): Promise<void>;
  /** Reject an inactive godown, or one belonging to another project (FR-REQ-003/-004). No-op when null. */
  assertGodownActiveInProject(
    companyId: string,
    godownId: string | null,
    projectId: string,
  ): Promise<void>;
  /** Reject an inactive item; return its base UoM (the line's UoM — MAS) (FR-REQ-004). */
  itemBaseUom(companyId: string, itemId: string): Promise<string>;
}

export const REQUISITION_MASTER_REF_PORT = Symbol('RequisitionMasterRefPort');
