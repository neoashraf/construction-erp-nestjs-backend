/**
 * BudgetCheckService (CC domain port) — the prospective over-budget check voucher modules depend on
 * (FR-CC-013/014). Given a draft's cost (EXPENSE-impact) lines it returns one advisory result per
 * distinct (project, cost centre): current actual + this draft's amount, classified. It is SOFT — it
 * NEVER throws on OVER and NEVER blocks a post (PostingService neither imports nor calls CC). Voucher
 * use cases call it during draft validation; the HTTP `POST /api/cost-control/budget-check` is the UI's
 * access to the same logic.
 */
import Decimal from 'decimal.js';
import { CostControlStatus } from '../cost-control.policy';

/** Company + financial-year context for a prospective check (company from JWT, never the body). */
export interface CompanyFyContext {
  companyId: string;
  financialYearId?: string;
}

/** One draft cost line: an EXPENSE amount tagged to a (project, cost centre). */
export interface DraftCostLine {
  projectId: string;
  costCentreId: string;
  amount: Decimal;
}

export interface ProspectiveResult {
  projectId: string;
  costCentreId: string;
  currentActual: Decimal;
  draftAmount: Decimal;
  budgetedAmount: Decimal | null;
  projectedUtilisationPct: Decimal | null;
  status: CostControlStatus;
}

export interface BudgetCheckService {
  /** One result per DISTINCT (project, cost centre) in `lines`; advisory only (FR-CC-013/014). */
  checkProspective(ctx: CompanyFyContext, lines: DraftCostLine[]): Promise<ProspectiveResult[]>;
}

export const BUDGET_CHECK_SERVICE = Symbol('BUDGET_CHECK_SERVICE');
