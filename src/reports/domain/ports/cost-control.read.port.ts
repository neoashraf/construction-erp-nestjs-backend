/**
 * CostControlReadPort (RPT · FR-RPT-018/-025) — PURE domain port. The seam to CC's canonical
 * budget-vs-actual metric (CC FR-CC-006/-007/-010/-015). RPT depends on this by interface; the adapter
 * (infrastructure) runs the SAME aggregation CC's `CostControlQueryService` uses — Σ(debit − credit) on
 * EXPENSE `journal_line` per (project, cost centre), joined to `project_budget`, classified by CC's PURE
 * `classify` policy — so RPT's `actualCost`/`variance`/`utilisationPct`/`status` EQUAL CC's for the same
 * params (single source of truth, FR-RPT-004). RPT renders them VERBATIM and never recomputes variance.
 * Company is always on the query (F3); the F4 project filter is applied server-side.
 */
import { CostCentreVarianceRow } from '../report-result.model';

export const COST_CONTROL_READ_PORT = Symbol('COST_CONTROL_READ_PORT');

export interface CostControlScope {
  companyId: string;
  /**
   * The effective project filter (F4): `null` = all projects (unscoped); `[]` = none (empty report);
   * `[ids]` = restricted to those projects.
   */
  projectIds: string[] | null;
  financialYearId?: string;
  costCentreId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface CostControlReadPort {
  /**
   * Budget-vs-actual per (project, cost centre), classified by CC's policy — an UNBUDGETED pair carries a
   * null budget/variance/utilisation (FR-RPT-018/-025; CC FR-CC-007/-015). Deterministically ordered.
   */
  budgetVsActual(scope: CostControlScope): Promise<CostCentreVarianceRow[]>;
}
