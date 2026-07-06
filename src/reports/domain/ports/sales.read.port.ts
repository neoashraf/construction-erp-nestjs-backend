/**
 * SalesReadPort (RPT · FR-RPT-016/-017/-020) — PURE domain port. The seam to SAL's per-IPC billing /
 * outstanding / retention read model (SAL FR-SAL-015/-016/-019). RPT depends on this by interface; the
 * adapter (infrastructure) runs the SAME formulas SAL's `IpcQueryService` uses over `sales_invoice`,
 * `retention_release`, and REC's `receipt_allocation` view — so RPT's figures EQUAL SAL's for the same
 * params (single source of truth, FR-RPT-004). RPT renders these VERBATIM and only DERIVES the ageing
 * bucket on top (FR-RPT-017). Company is always on the query (F3); the F4 project filter is applied
 * server-side. Every method is a non-blocking SELECT/aggregate — no write, no PostingService.
 */
export const SALES_READ_PORT = Symbol('SALES_READ_PORT');

export interface SalesScope {
  companyId: string;
  /**
   * The effective project filter (F4): `null` = all projects (unscoped); `[]` = none (a project-scoped
   * user with no assignments → a valid empty report); `[ids]` = restricted to those projects.
   */
  projectIds: string[] | null;
  financialYearId?: string;
  /** IPC certificate-date window (FR-RPT-016). */
  dateFrom?: string;
  dateTo?: string;
}

/**
 * A per-IPC billing read row — SAL's figures VERBATIM (no ageing bucket; RPT adds it, FR-RPT-017). Money is
 * SAL's `numeric(18,4)` serialised as decimal strings (never float); dates are 'YYYY-MM-DD'.
 */
export interface IpcBillingReadRow {
  ipcId: string;
  projectId: string;
  ipcNo: string | null;
  ipcDate: string;
  dueDate: string;
  certifiedAmount: string;
  billedAmount: string;
  receivedAmount: string;
  outstandingAmount: string;
  retentionHeld: string;
}

/** Project cumulative totals across the returned IPC rows — SAL's reconciling sums. */
export interface IpcBillingTotals {
  certified: string;
  billed: string;
  received: string;
  outstanding: string;
  retentionHeld: string;
}

export interface SalesReadPort {
  /**
   * Per-IPC certified / billed / received / outstanding / retention-held (SAL, POSTED IPCs) + the project
   * cumulative totals (FR-RPT-016/-020). RPT derives the ageing bucket on top (FR-RPT-017).
   */
  ipcBilling(scope: SalesScope): Promise<{ rows: IpcBillingReadRow[]; totals: IpcBillingTotals }>;
}
