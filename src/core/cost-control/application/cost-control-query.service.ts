/**
 * CostControlQueryService (CC application) — the read endpoints' logic (FR-CC-006…012/016). Composes
 * `CostControlReadRepository` aggregations with the pure `classify` policy to serve budget-vs-actual,
 * profitability, and the current OVER/APPROACHING alerts. It is the single source of the budget /
 * variance / utilisation / profit metric definitions RPT and DSH consume (FR-CC-010) — they call CC
 * and never re-derive. Every query is company-scoped (F3); the alerts feed and PM reads apply the
 * explicit assigned-projects filter (F4). Money/utilisation are exact decimals serialised to strings.
 */
import Decimal from 'decimal.js';
import { Inject, Injectable } from '@nestjs/common';
import { Actor } from '../../tenancy/tenant-context';
import { ValidationError } from '../../../common/errors/domain-error';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import {
  classify,
  CostControlStatus,
  UTILISATION_SCALE,
} from '../domain/cost-control.policy';
import {
  COST_CONTROL_READ_REPOSITORY,
  CostControlReadRepository,
  LedgerScope,
  ProfitGroupBy,
  splitPairKey,
} from '../domain/ports/cost-control.read.port';

const MONEY_SCALE = 4;
const ALL_STATUSES: CostControlStatus[] = ['OK', 'APPROACHING', 'OVER', 'UNBUDGETED'];
const ALERT_STATUSES: CostControlStatus[] = ['OVER', 'APPROACHING'];

export interface BudgetVsActualRow {
  projectId: string;
  costCentreId: string;
  budgetedAmount: string | null;
  actualCost: string;
  variance: string | null;
  utilisationPct: string | null;
  status: CostControlStatus;
}

export interface ProfitabilityRow {
  projectId: string | null;
  costCentreId: string | null;
  revenue: string;
  cost: string;
  profit: string;
}

export interface BudgetVsActualFilter {
  page?: number;
  pageSize?: number;
  financialYearId?: string;
  projectId?: string;
  costCentreId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string; // csv of the status enum
}

export interface ProfitabilityFilter {
  page?: number;
  pageSize?: number;
  groupBy?: string;
  financialYearId?: string;
  projectId?: string;
  costCentreId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface AlertsFilter {
  page?: number;
  pageSize?: number;
  status?: string; // subset of OVER,APPROACHING
  projectId?: string;
}

@Injectable()
export class CostControlQueryService {
  constructor(
    @Inject(COST_CONTROL_READ_REPOSITORY)
    private readonly repo: CostControlReadRepository,
  ) {}

  // ===== budget vs actual (FR-CC-006/007/008/011/012/015) =========================================
  async budgetVsActual(filter: BudgetVsActualFilter, actor: Actor): Promise<Paginated<BudgetVsActualRow>> {
    this.assertDateOrder(filter.dateFrom, filter.dateTo);
    const statusFilter = this.parseStatuses(filter.status, ALL_STATUSES);
    const scope = this.scopeOf(filter, actor);

    const rows = await this.computeBudgetVsActual(scope);
    const filtered = statusFilter ? rows.filter((r) => statusFilter.has(r.status)) : rows;
    return this.paginate(filtered, filter);
  }

  // ===== profitability (FR-CC-009/010) ============================================================
  async profitability(filter: ProfitabilityFilter, actor: Actor): Promise<Paginated<ProfitabilityRow>> {
    this.assertDateOrder(filter.dateFrom, filter.dateTo);
    const groupBy = this.parseGroupBy(filter.groupBy);
    const scope = this.scopeOf(filter, actor);

    const aggs = await this.repo.profitability(scope, groupBy);
    const rows: ProfitabilityRow[] = aggs.map((a) => {
      const profit = a.revenue.minus(a.cost);
      return {
        projectId: a.projectId,
        costCentreId: a.costCentreId,
        revenue: a.revenue.toFixed(MONEY_SCALE),
        cost: a.cost.toFixed(MONEY_SCALE),
        profit: profit.toFixed(MONEY_SCALE),
      };
    });
    return this.paginate(rows, filter);
  }

  // ===== current alerts (FR-CC-011/012/016) =======================================================
  async alerts(filter: AlertsFilter, actor: Actor): Promise<Paginated<BudgetVsActualRow>> {
    const statusFilter = this.parseStatuses(filter.status, ALERT_STATUSES);
    if (statusFilter) {
      for (const s of statusFilter) {
        if (!ALERT_STATUSES.includes(s)) {
          throw new ValidationError(`status must be a subset of OVER,APPROACHING`, { status: s });
        }
      }
    }
    // Alerts are always lifetime-cumulative (no FY/date window) and always project-scoped (F4).
    const scope = this.scopeOf({ projectId: filter.projectId }, actor);

    const rows = await this.computeBudgetVsActual(scope);
    const wanted = statusFilter ?? new Set(ALERT_STATUSES);
    const alerts = rows.filter((r) => wanted.has(r.status));
    return this.paginate(alerts, filter);
  }

  // ===== shared computation =======================================================================

  /** Union of budgeted and actual (project, cost centre) pairs, each classified. */
  private async computeBudgetVsActual(scope: LedgerScope): Promise<BudgetVsActualRow[]> {
    const [actuals, budgets] = await Promise.all([
      this.repo.actualByPair(scope),
      this.repo.budgetsByPair(scope),
    ]);

    const keys = new Set<string>([...actuals.keys(), ...budgets.keys()]);
    const rows: BudgetVsActualRow[] = [];
    for (const key of keys) {
      const { projectId, costCentreId } = splitPairKey(key);
      const actual = actuals.get(key) ?? new Decimal(0);
      const budgeted = budgets.get(key) ?? null;
      const { status, utilisationPct } = classify(budgeted, actual);
      rows.push({
        projectId,
        costCentreId,
        budgetedAmount: budgeted !== null ? budgeted.toFixed(MONEY_SCALE) : null,
        actualCost: actual.toFixed(MONEY_SCALE),
        variance: budgeted !== null ? budgeted.minus(actual).toFixed(MONEY_SCALE) : null,
        utilisationPct: utilisationPct !== null ? utilisationPct.toFixed(UTILISATION_SCALE) : null,
        status,
      });
    }
    // Stable deterministic order (project, then cost centre) for pagination.
    rows.sort((a, b) =>
      a.projectId === b.projectId
        ? a.costCentreId.localeCompare(b.costCentreId)
        : a.projectId.localeCompare(b.projectId),
    );
    return rows;
  }

  // ===== helpers ==================================================================================

  /**
   * Build a `LedgerScope` from the request + actor, applying the F4 project-scope filter for PMs.
   * A scoped (PM) actor is always narrowed to `assignedProjectIds`, so even without a `projectId`
   * filter the aggregation never leaks another project's figures. The controller separately rejects a
   * PM who *explicitly* filters an unassigned `projectId` with 403 (contract).
   */
  private scopeOf(
    filter: {
      financialYearId?: string;
      projectId?: string;
      costCentreId?: string;
      dateFrom?: string;
      dateTo?: string;
    },
    actor: Actor,
  ): LedgerScope {
    return {
      companyId: actor.companyId,
      financialYearId: filter.financialYearId,
      projectId: filter.projectId,
      costCentreId: filter.costCentreId,
      dateFrom: filter.dateFrom,
      dateTo: filter.dateTo,
      assignedProjectIds: actor.isUnscoped ? undefined : actor.assignedProjectIds,
    };
  }

  private assertDateOrder(dateFrom?: string, dateTo?: string): void {
    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw new ValidationError('dateFrom must be <= dateTo', { dateFrom, dateTo });
    }
  }

  private parseStatuses(csv: string | undefined, allowed: CostControlStatus[]): Set<CostControlStatus> | null {
    if (!csv) return null;
    const tokens = csv.split(',').map((t) => t.trim()).filter(Boolean);
    const set = new Set<CostControlStatus>();
    for (const t of tokens) {
      if (!allowed.includes(t as CostControlStatus)) {
        throw new ValidationError(`Unknown status '${t}'`, { allowed });
      }
      set.add(t as CostControlStatus);
    }
    return set.size > 0 ? set : null;
  }

  private parseGroupBy(token: string | undefined): ProfitGroupBy {
    switch ((token ?? 'cost_centre').toLowerCase()) {
      case 'cost_centre':
        return 'COST_CENTRE';
      case 'project':
        return 'PROJECT';
      case 'project_cost_centre':
        return 'PROJECT_COST_CENTRE';
      default:
        throw new ValidationError(`Unknown groupBy '${token}'`, {
          allowed: ['cost_centre', 'project', 'project_cost_centre'],
        });
    }
  }

  private paginate<T>(rows: T[], req: { page?: number; pageSize?: number }): Paginated<T> {
    const { page, pageSize, skip, take } = resolvePaging(req);
    return new Paginated(rows.slice(skip, skip + take), page, pageSize, rows.length);
  }
}
