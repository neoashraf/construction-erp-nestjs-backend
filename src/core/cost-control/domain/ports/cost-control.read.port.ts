/**
 * CostControlReadRepository (CC domain port). The read substrate CC aggregates over: EXPENSE/INCOME
 * sums on posted `journal_line` (LED) grouped by the four dimensions, `project_budget` reads (MAS),
 * and purpose/godown → owning-project resolution for the FR-CC-004 consistency rule. PURE interface —
 * the TypeORM adapter lives in infrastructure. All reads are `company_id`-scoped (ADR-0002 F3); the
 * optional `assignedProjectIds` applies the explicit project-scope filter for PMs (F4).
 */
import Decimal from 'decimal.js';

/** Stable key for a (project, cost centre) pair. */
export type PairKey = string;
export function pairKey(projectId: string, costCentreId: string): PairKey {
  return `${projectId}|${costCentreId}`;
}
export function splitPairKey(key: PairKey): { projectId: string; costCentreId: string } {
  const [projectId, costCentreId] = key.split('|');
  return { projectId: projectId!, costCentreId: costCentreId! };
}

/** Scope for a ledger aggregation. `company_id` mandatory; the rest narrow the window. */
export interface LedgerScope {
  companyId: string;
  /** Omit → lifetime actual (authoritative for over-budget); supply → that FY only (reporting view). */
  financialYearId?: string;
  projectId?: string;
  costCentreId?: string;
  /** `voucher_date` window (reporting view). */
  dateFrom?: string;
  dateTo?: string;
  /**
   * Explicit project-scope filter (ADR-0002 F4). `undefined` → no filter (unscoped Admin/Accounts);
   * a list → restrict to those project ids; an empty list → match nothing (scoped PM, no assignments).
   */
  assignedProjectIds?: readonly string[];
}

export type ProfitGroupBy = 'COST_CENTRE' | 'PROJECT' | 'PROJECT_COST_CENTRE';

/** Raw revenue/cost aggregation row (profit computed by the query service). */
export interface ProfitabilityAgg {
  projectId: string | null;
  costCentreId: string | null;
  revenue: Decimal;
  cost: Decimal;
}

export interface CostControlReadRepository {
  /** Σ(debit − credit) on EXPENSE accounts, grouped by (project, cost centre), scoped. */
  actualByPair(scope: LedgerScope): Promise<Map<PairKey, Decimal>>;
  /** `project_budget.budgeted_amount` per (project, cost centre), company + optional project/CC scoped. */
  budgetsByPair(scope: LedgerScope): Promise<Map<PairKey, Decimal>>;
  /** revenue Σ(credit − debit) on INCOME + cost Σ(debit − credit) on EXPENSE, grouped by `groupBy`. */
  profitability(scope: LedgerScope, groupBy: ProfitGroupBy): Promise<ProfitabilityAgg[]>;
  /** Map each purpose id → its owning project id (FR-CC-004), company-scoped. Missing ids are absent. */
  projectOfPurposes(companyId: string, purposeIds: string[]): Promise<Map<string, string>>;
  /** Map each godown id → its owning project id (FR-CC-004), company-scoped. Missing ids are absent. */
  projectOfGodowns(companyId: string, godownIds: string[]): Promise<Map<string, string>>;
}

export const COST_CONTROL_READ_REPOSITORY = Symbol('COST_CONTROL_READ_REPOSITORY');
