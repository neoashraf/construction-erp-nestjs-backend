/**
 * RequisitionReadAdapter (RPT · FR-RPT-024) — INFRASTRUCTURE `RequisitionReadPort`. Reads REQ's OWN
 * requisition/issue projection via `@Inject(DATA_SOURCE)` + `getManager`: `requisition` ⋈ `requisition_line`
 * (REQ maintains the denormalised `requested_quantity` / `issued_quantity` per line; the invariant
 * `issued + balance = requested` is enforced by REQ). RPT reads REQ's figures and the query service derives
 * the variance. Read-only; company on every query (F3); assigned-projects filter applied (F4).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../database/database.module';
import { getManager } from '../../infrastructure/unit-of-work/transaction-context';
import { resolvePaging } from '../../infrastructure/http/pagination';
import {
  RequisitionIssueReadRow,
  RequisitionReadPort,
  RequisitionScope,
} from '../domain/ports/requisition.read.port';
import { PaginatedRows } from '../domain/ports/ledger.read.port';

@Injectable()
export class RequisitionReadAdapter implements RequisitionReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  async requisitionVsIssue(scope: RequisitionScope): Promise<PaginatedRows<RequisitionIssueReadRow>> {
    const m = this.manager();
    const params: unknown[] = [scope.companyId];
    const conds = ['r.company_id = $1', 'r.deleted_at IS NULL'];
    const push = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.financialYearId) push('r.financial_year_id = $$', scope.financialYearId);
    if (scope.costCentreId) push('r.cost_centre_id = $$', scope.costCentreId);
    if (scope.requisitionId) push('r.id = $$', scope.requisitionId);
    if (scope.dateFrom) push('r.required_date >= $$', scope.dateFrom);
    if (scope.dateTo) push('r.required_date <= $$', scope.dateTo);
    // F4 project filter: null → all; [] → none; [ids] → ANY.
    if (scope.projectIds === null) {
      // all projects
    } else if (scope.projectIds.length === 0) {
      conds.push('false');
    } else {
      params.push(scope.projectIds);
      conds.push(`r.project_id = ANY($${params.length}::uuid[])`);
    }
    const where = conds.join(' AND ');
    const from =
      'FROM requisition_line rl JOIN requisition r ON r.id = rl.requisition_id';

    const [{ count }] = await m.query(`SELECT count(*)::text AS count ${from} WHERE ${where}`, params);
    const total = parseInt(count, 10);

    const { skip, take } = resolvePaging(scope);
    const rows = await m.query(
      `SELECT r.id AS requisition_id, r.project_id, r.cost_centre_id, rl.item_id,
              rl.requested_quantity::text AS requested, rl.issued_quantity::text AS issued
         ${from} WHERE ${where}
        ORDER BY r.required_date ASC, r.requisition_no ASC, rl.line_no ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return {
      items: rows.map((r: Record<string, string | null>) => ({
        requisitionId: r.requisition_id as string,
        projectId: (r.project_id as string) ?? null,
        costCentreId: (r.cost_centre_id as string) ?? null,
        itemId: r.item_id as string,
        requestedQty: new Decimal(r.requested ?? '0').toFixed(4),
        issuedQty: new Decimal(r.issued ?? '0').toFixed(4),
      })),
      total,
    };
  }
}
