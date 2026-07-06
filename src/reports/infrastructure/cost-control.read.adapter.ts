/**
 * CostControlReadAdapter (RPT · FR-RPT-018/-025) — INFRASTRUCTURE `CostControlReadPort`. Reads CC's OWN
 * budget-vs-actual metric via `@Inject(DATA_SOURCE)` + `getManager` (the sanctioned cross-module read) and
 * CC's PURE `classify` policy — CC exports no query service (only its check ports), and this brief forbids
 * modifying CC, so RPT runs the identical scoped SQL CC's `TypeOrmCostControlReadRepository` uses:
 * Σ(debit − credit) on EXPENSE `journal_line` per (project, cost centre) as the actual, `project_budget`
 * (lifetime, not FY/date scoped) as the budget, classified by CC's `classify`. The result therefore EQUALS
 * CC's `budget-vs-actual` for the same params (single source of truth, FR-RPT-004/-025) — RPT renders
 * `actualCost`/`variance`/`utilisationPct`/`status` VERBATIM (incl. UNBUDGETED) and never recomputes.
 *
 * Read-only: only SELECT/aggregate; company is on every query (F3); the F4 project filter is applied
 * server-side; money is CC's numeric(18,4) rehydrated to Decimal (exact, never float).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../database/database.module';
import { getManager } from '../../infrastructure/unit-of-work/transaction-context';
import {
  classify,
  UTILISATION_SCALE,
} from '../../core/cost-control/domain/cost-control.policy';
import { CostCentreVarianceRow } from '../domain/report-result.model';
import { CostControlReadPort, CostControlScope } from '../domain/ports/cost-control.read.port';

const MONEY_SCALE = 4;

/** Stable (project, cost centre) key — mirrors CC's `pairKey`. */
function pairKey(projectId: string, costCentreId: string): string {
  return `${projectId}|${costCentreId}`;
}

@Injectable()
export class CostControlReadAdapter implements CostControlReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  async budgetVsActual(scope: CostControlScope): Promise<CostCentreVarianceRow[]> {
    // F4: [] → a valid empty report, never all projects.
    if (scope.projectIds !== null && scope.projectIds.length === 0) return [];

    const [actuals, budgets] = await Promise.all([this.actualByPair(scope), this.budgetsByPair(scope)]);

    const keys = new Set<string>([...actuals.keys(), ...budgets.keys()]);
    const rows: CostCentreVarianceRow[] = [];
    for (const key of keys) {
      const [projectId, costCentreId] = key.split('|');
      const actual = actuals.get(key) ?? new Decimal(0);
      const budgeted = budgets.get(key) ?? null;
      const { status, utilisationPct } = classify(budgeted, actual);
      rows.push({
        projectId: projectId!,
        costCentreId: costCentreId!,
        budgetedAmount: budgeted !== null ? budgeted.toFixed(MONEY_SCALE) : null,
        actualCost: actual.toFixed(MONEY_SCALE),
        variance: budgeted !== null ? budgeted.minus(actual).toFixed(MONEY_SCALE) : null,
        utilisationPct: utilisationPct !== null ? utilisationPct.toFixed(UTILISATION_SCALE) : null,
        status,
      });
    }
    // Deterministic (project, then cost centre) order — matches CC's budget-vs-actual ordering.
    rows.sort((a, b) =>
      a.projectId === b.projectId
        ? a.costCentreId.localeCompare(b.costCentreId)
        : a.projectId.localeCompare(b.projectId),
    );
    return rows;
  }

  /** Σ(debit − credit) on EXPENSE, grouped by (project, cost centre) — CC's `actualByPair` SQL. */
  private async actualByPair(scope: CostControlScope): Promise<Map<string, Decimal>> {
    const params: unknown[] = [scope.companyId];
    const conds = ['je.company_id = $1'];
    const add = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.financialYearId) add('je.financial_year_id = $$', scope.financialYearId);
    if (scope.dateFrom) add('je.voucher_date >= $$', scope.dateFrom);
    if (scope.dateTo) add('je.voucher_date <= $$', scope.dateTo);
    if (scope.costCentreId) add('jl.cost_centre_id = $$', scope.costCentreId);
    if (scope.projectIds !== null) add('jl.project_id = ANY($$::uuid[])', scope.projectIds);

    const rows: Array<{ project_id: string; cost_centre_id: string; actual: string }> = await this.manager().query(
      `SELECT jl.project_id, jl.cost_centre_id,
              SUM(jl.debit - jl.credit)::numeric(18,4)::text AS actual
         FROM journal_line jl
         JOIN journal_entry je ON je.id = jl.journal_entry_id
         JOIN account a ON a.id = jl.account_id
        WHERE ${conds.join(' AND ')}
          AND a.type = 'EXPENSE'
          AND jl.project_id IS NOT NULL
          AND jl.cost_centre_id IS NOT NULL
        GROUP BY jl.project_id, jl.cost_centre_id`,
      params,
    );
    const map = new Map<string, Decimal>();
    for (const r of rows) map.set(pairKey(r.project_id, r.cost_centre_id), new Decimal(r.actual));
    return map;
  }

  /** `project_budget.budgeted_amount` per (project, cost centre) — lifetime, not FY/date scoped (CC). */
  private async budgetsByPair(scope: CostControlScope): Promise<Map<string, Decimal>> {
    const params: unknown[] = [scope.companyId];
    const conds = ['company_id = $1'];
    const add = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.costCentreId) add('cost_centre_id = $$', scope.costCentreId);
    if (scope.projectIds !== null) add('project_id = ANY($$::uuid[])', scope.projectIds);

    const rows: Array<{ project_id: string; cost_centre_id: string; budgeted: string }> = await this.manager().query(
      `SELECT project_id, cost_centre_id, budgeted_amount::numeric(18,4)::text AS budgeted
         FROM project_budget
        WHERE ${conds.join(' AND ')}`,
      params,
    );
    const map = new Map<string, Decimal>();
    for (const r of rows) map.set(pairKey(r.project_id, r.cost_centre_id), new Decimal(r.budgeted));
    return map;
  }
}
