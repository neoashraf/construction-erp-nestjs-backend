/**
 * StockLedgerQueryService — INV read side (skill §2.3): DTOs straight from SQL over the append-only
 * `stock_movement` table, no aggregates. Two reads under `/api/stock-journal/stock-ledger`:
 *   - stockLedger : one row per `(godown, item)` — quantityOnHand = Σ signed qty, totalValue = Σ signed
 *                   value, weightedAverageRate = totalValue/quantityOnHand (null when qty 0), computed
 *                   from movements; `?asOfDate` bounds to movements with voucher_date <= date (FR-INV-004,
 *                   -021). The projection is DERIVED — never a stored balance (FR-INV-004).
 *   - movements   : the chronological append-only history for a `(godown, item)`, each row carrying
 *                   sourceType/sourceId and the balance*After snapshot (FR-INV-004, -021).
 *
 * Every read is company-scoped (F3/NFR-005); a project-scoped user (PM/Store Keeper) is restricted to
 * godowns of their assigned projects (the godown master fixes godown→project). Money/qty are serialised
 * as Decimal(18,4) strings (never JSON numbers), per the API contract.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ValidationError } from '../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import {
  StockLedgerFilter,
  StockLedgerReadPort,
  StockLedgerRow,
  StockMovementFilter,
  StockMovementRow,
} from '../domain/ports/stock-balance.read.port';

@Injectable()
export class StockLedgerQueryService implements StockLedgerReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  /**
   * A project-scope predicate: restrict a scoped user to godowns whose project is assigned to them.
   * Returns null for unscoped actors, `'false'` for a scoped user with no assignments, else an EXISTS
   * over the godown master. `godownCol` is the movement/row alias's godown column.
   */
  private godownScopeClause(actor: Actor, params: unknown[], godownCol: string): string | null {
    if (actor.isUnscoped) return null;
    if (actor.assignedProjectIds.length === 0) return 'false';
    params.push(actor.assignedProjectIds);
    return `EXISTS (SELECT 1 FROM godown g WHERE g.id = ${godownCol} AND g.project_id = ANY($${params.length}::uuid[]))`;
  }

  // ===== stock ledger (per godown/item) ==========================================================
  async stockLedger(filter: StockLedgerFilter, actor: Actor): Promise<Paginated<StockLedgerRow>> {
    if (filter.asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(filter.asOfDate)) {
      throw new ValidationError('asOfDate must be YYYY-MM-DD', { field: 'asOfDate' });
    }
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const params: unknown[] = [actor.companyId];
    const conds = ['m.company_id = $1'];
    const add = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (filter.godownId) add('m.godown_id = $$', filter.godownId);
    if (filter.itemId) add('m.item_id = $$', filter.itemId);
    if (filter.asOfDate) add('m.voucher_date <= $$', filter.asOfDate);
    if (filter.projectId) {
      params.push(filter.projectId);
      conds.push(
        `EXISTS (SELECT 1 FROM godown g WHERE g.id = m.godown_id AND g.project_id = $${params.length})`,
      );
    }
    const scope = this.godownScopeClause(actor, params, 'm.godown_id');
    if (scope) conds.push(scope);
    const where = conds.join(' AND ');

    // signed effect: IN adds, OUT subtracts. Group by (godown, item); qty>0 keeps zero-balance pairs out.
    const projection = `
      SELECT m.godown_id, m.item_id,
             SUM(CASE WHEN m.direction = 'IN' THEN m.quantity ELSE -m.quantity END)::numeric(18,4) AS qty,
             SUM(CASE WHEN m.direction = 'IN' THEN m.value ELSE -m.value END)::numeric(18,4) AS val
        FROM stock_movement m
       WHERE ${where}
       GROUP BY m.godown_id, m.item_id`;

    const [{ count }] = await this.manager().query(
      `SELECT count(*)::text AS count FROM (${projection}) p`,
      params,
    );
    const total = parseInt(count, 10);

    const rows = await this.manager().query(
      `SELECT p.godown_id, p.item_id,
              p.qty::text AS quantity_on_hand,
              p.val::text AS total_value,
              CASE WHEN p.qty = 0 THEN NULL ELSE (p.val / p.qty)::numeric(18,4)::text END AS weighted_average_rate
         FROM (${projection}) p
        ORDER BY p.godown_id ASC, p.item_id ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );

    return new Paginated(
      rows.map(
        (r: Record<string, string | null>): StockLedgerRow => ({
          godownId: r.godown_id as string,
          itemId: r.item_id as string,
          quantityOnHand: r.quantity_on_hand as string,
          totalValue: r.total_value as string,
          weightedAverageRate: (r.weighted_average_rate as string) ?? null,
          asOfDate: filter.asOfDate ?? null,
        }),
      ),
      page,
      pageSize,
      total,
    );
  }

  // ===== movement history ========================================================================
  async movements(filter: StockMovementFilter, actor: Actor): Promise<Paginated<StockMovementRow>> {
    if (!filter.godownId || !filter.itemId) {
      throw new ValidationError('godownId and itemId are required', { fields: ['godownId', 'itemId'] });
    }
    if (filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo) {
      throw new ValidationError('dateFrom must be <= dateTo', { field: 'dateFrom' });
    }
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const params: unknown[] = [actor.companyId, filter.godownId, filter.itemId];
    const conds = ['m.company_id = $1', 'm.godown_id = $2', 'm.item_id = $3'];
    const add = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (filter.dateFrom) add('m.voucher_date >= $$', filter.dateFrom);
    if (filter.dateTo) add('m.voucher_date <= $$', filter.dateTo);
    const scope = this.godownScopeClause(actor, params, 'm.godown_id');
    if (scope) conds.push(scope);
    const where = conds.join(' AND ');

    const [{ count }] = await this.manager().query(
      `SELECT count(*)::text AS count FROM stock_movement m WHERE ${where}`,
      params,
    );
    const total = parseInt(count, 10);

    const rows = await this.manager().query(
      `SELECT m.id, m.godown_id, m.item_id, m.source_type, m.source_id, m.direction,
              m.quantity::text AS quantity, m.rate::text AS rate, m.value::text AS value,
              m.balance_qty_after::text AS balance_qty_after,
              m.balance_value_after::text AS balance_value_after,
              m.avg_rate_after::text AS avg_rate_after,
              m.is_reversal, m.reversal_of,
              to_char(m.voucher_date, 'YYYY-MM-DD') AS voucher_date,
              to_char(m.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS posted_at
         FROM stock_movement m
        WHERE ${where}
        ORDER BY m.voucher_date ASC, m.posted_at ASC, m.id ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );

    return new Paginated(
      rows.map(
        (r: Record<string, unknown>): StockMovementRow => ({
          id: r.id as string,
          godownId: r.godown_id as string,
          itemId: r.item_id as string,
          sourceType: r.source_type as string,
          sourceId: r.source_id as string,
          direction: r.direction as 'IN' | 'OUT',
          quantity: r.quantity as string,
          rate: r.rate as string,
          value: r.value as string,
          balanceQtyAfter: r.balance_qty_after as string,
          balanceValueAfter: r.balance_value_after as string,
          avgRateAfter: (r.avg_rate_after as string) ?? null,
          isReversal: r.is_reversal as boolean,
          reversalOf: (r.reversal_of as string) ?? null,
          voucherDate: r.voucher_date as string,
          postedAt: r.posted_at as string,
        }),
      ),
      page,
      pageSize,
      total,
    );
  }
}
