/**
 * TypeOrmCostControlReadRepository (CC infrastructure) — the ONLY place CC touches the DB. Raw,
 * parameterised SQL aggregations over `journal_line ⋈ journal_entry ⋈ account` (LED) and reads of
 * `project_budget` / `purpose` / `godown` (MAS). CC owns no table and no migration — it only reads.
 * Every query is `company_id`-scoped (F3); `assignedProjectIds` applies the PM project filter (F4).
 * Sums are `numeric(18,4)` cast to text and rehydrated to `Decimal` (exact money, never float).
 */
import Decimal from 'decimal.js';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import {
  CostControlReadRepository,
  LedgerScope,
  PairKey,
  pairKey,
  ProfitabilityAgg,
  ProfitGroupBy,
} from '../domain/ports/cost-control.read.port';

@Injectable()
export class TypeOrmCostControlReadRepository implements CostControlReadRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  /** Shared WHERE builder for the ledger aggregations (EXPENSE/INCOME filter added by the caller). */
  private ledgerWhere(scope: LedgerScope): { where: string; params: unknown[] } {
    const params: unknown[] = [scope.companyId];
    const conds = ['je.company_id = $1'];
    const add = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.financialYearId) add('je.financial_year_id = $$', scope.financialYearId);
    if (scope.dateFrom) add('je.voucher_date >= $$', scope.dateFrom);
    if (scope.dateTo) add('je.voucher_date <= $$', scope.dateTo);
    if (scope.projectId) add('jl.project_id = $$', scope.projectId);
    if (scope.costCentreId) add('jl.cost_centre_id = $$', scope.costCentreId);
    if (scope.assignedProjectIds !== undefined) {
      // Explicit project-scope filter (F4). Empty list → matches nothing.
      params.push(scope.assignedProjectIds);
      conds.push(`jl.project_id = ANY($${params.length}::uuid[])`);
    }
    return { where: conds.join(' AND '), params };
  }

  // ===== actual cost per (project, cost centre) — EXPENSE only ====================================
  async actualByPair(scope: LedgerScope): Promise<Map<PairKey, Decimal>> {
    const { where, params } = this.ledgerWhere(scope);
    const rows: Array<{ project_id: string; cost_centre_id: string; actual: string }> =
      await this.manager().query(
        `SELECT jl.project_id, jl.cost_centre_id,
                SUM(jl.debit - jl.credit)::numeric(18,4)::text AS actual
           FROM journal_line jl
           JOIN journal_entry je ON je.id = jl.journal_entry_id
           JOIN account a ON a.id = jl.account_id
          WHERE ${where}
            AND a.type = 'EXPENSE'
            AND jl.project_id IS NOT NULL
            AND jl.cost_centre_id IS NOT NULL
          GROUP BY jl.project_id, jl.cost_centre_id`,
        params,
      );
    const map = new Map<PairKey, Decimal>();
    for (const r of rows) {
      map.set(pairKey(r.project_id, r.cost_centre_id), new Decimal(r.actual));
    }
    return map;
  }

  // ===== budgets per (project, cost centre) — lifetime, not FY/date scoped ========================
  async budgetsByPair(scope: LedgerScope): Promise<Map<PairKey, Decimal>> {
    const params: unknown[] = [scope.companyId];
    const conds = ['company_id = $1'];
    const add = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.projectId) add('project_id = $$', scope.projectId);
    if (scope.costCentreId) add('cost_centre_id = $$', scope.costCentreId);
    if (scope.assignedProjectIds !== undefined) {
      params.push(scope.assignedProjectIds);
      conds.push(`project_id = ANY($${params.length}::uuid[])`);
    }
    const rows: Array<{ project_id: string; cost_centre_id: string; budgeted: string }> =
      await this.manager().query(
        `SELECT project_id, cost_centre_id, budgeted_amount::numeric(18,4)::text AS budgeted
           FROM project_budget
          WHERE ${conds.join(' AND ')}`,
        params,
      );
    const map = new Map<PairKey, Decimal>();
    for (const r of rows) {
      map.set(pairKey(r.project_id, r.cost_centre_id), new Decimal(r.budgeted));
    }
    return map;
  }

  // ===== profitability: revenue (INCOME) + cost (EXPENSE), grouped ================================
  async profitability(scope: LedgerScope, groupBy: ProfitGroupBy): Promise<ProfitabilityAgg[]> {
    const { where, params } = this.ledgerWhere(scope);
    const wantsProject = groupBy === 'PROJECT' || groupBy === 'PROJECT_COST_CENTRE';
    const wantsCostCentre = groupBy === 'COST_CENTRE' || groupBy === 'PROJECT_COST_CENTRE';
    const selectCols = [
      wantsProject ? 'jl.project_id' : 'NULL::uuid AS project_id',
      wantsCostCentre ? 'jl.cost_centre_id' : 'NULL::uuid AS cost_centre_id',
    ];
    const groupCols: string[] = [];
    if (wantsProject) groupCols.push('jl.project_id');
    if (wantsCostCentre) groupCols.push('jl.cost_centre_id');

    const rows: Array<{ project_id: string | null; cost_centre_id: string | null; revenue: string; cost: string }> =
      await this.manager().query(
        `SELECT ${selectCols.join(', ')},
                COALESCE(SUM(CASE WHEN a.type = 'INCOME'  THEN jl.credit - jl.debit ELSE 0 END), 0)::numeric(18,4)::text AS revenue,
                COALESCE(SUM(CASE WHEN a.type = 'EXPENSE' THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric(18,4)::text AS cost
           FROM journal_line jl
           JOIN journal_entry je ON je.id = jl.journal_entry_id
           JOIN account a ON a.id = jl.account_id
          WHERE ${where}
            AND a.type IN ('INCOME', 'EXPENSE')
          GROUP BY ${groupCols.join(', ')}
          ORDER BY ${groupCols.join(', ')}`,
        params,
      );
    return rows.map((r) => ({
      projectId: r.project_id ?? null,
      costCentreId: r.cost_centre_id ?? null,
      revenue: new Decimal(r.revenue),
      cost: new Decimal(r.cost),
    }));
  }

  // ===== purpose/godown → owning project (FR-CC-004) ==============================================
  async projectOfPurposes(companyId: string, purposeIds: string[]): Promise<Map<string, string>> {
    return this.resolveOwners('purpose', companyId, purposeIds);
  }

  async projectOfGodowns(companyId: string, godownIds: string[]): Promise<Map<string, string>> {
    return this.resolveOwners('godown', companyId, godownIds);
  }

  private async resolveOwners(
    table: 'purpose' | 'godown',
    companyId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (ids.length === 0) return map;
    const rows: Array<{ id: string; project_id: string }> = await this.manager().query(
      `SELECT id, project_id FROM ${table} WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, ids],
    );
    for (const r of rows) map.set(r.id, r.project_id);
    return map;
  }
}
