/**
 * InventoryReadAdapter (RPT · FR-RPT-021/-022/-023) — INFRASTRUCTURE `InventoryReadPort`. Reads INV's OWN
 * stock-ledger projection and Stock Journal header via `@Inject(DATA_SOURCE)` + `getManager` (the sanctioned
 * cross-module read): the LIVE `stock_balance` snapshot, or — as-of a date — the running balance INV already
 * stamped on `stock_movement` (`balance_qty_after` / `balance_value_after` / `avg_rate_after`). RPT NEVER
 * recomputes valuation (FR-RPT-004; INV FR-INV-004/-005). Read-only: only SELECT/aggregate; company is on
 * every query (F3); money is INV's numeric(18,4) serialised as decimal strings (never float).
 *
 * NOTE (FR-RPT-022, §15): MAS holds NO reorder_level attribute on item/godown (confirmed — no such column),
 * so the low-stock threshold comes ONLY from the `reorderLevel` report param. Adding a MAS-owned
 * item/godown reorder_level column is a MAS follow-up (RPT must not add it — RPT owns no migration).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../database/database.module';
import { getManager } from '../../infrastructure/unit-of-work/transaction-context';
import { resolvePaging } from '../../infrastructure/http/pagination';
import { StockMovementSummaryRow, StockValuationRow } from '../domain/report-result.model';
import { InventoryReadPort, InventoryScope } from '../domain/ports/inventory.read.port';
import { PaginatedRows } from '../domain/ports/ledger.read.port';

/** Posted Stock Journal statuses that represent actual, ledger-affecting stock movement. */
const POSTED_STATUS = 'POSTED';

@Injectable()
export class InventoryReadAdapter implements InventoryReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  // ── stock valuation (FR-RPT-021) ─────────────────────────────────────────────────────────────────
  async stockValuation(scope: InventoryScope): Promise<{ rows: StockValuationRow[]; totalValue: string }> {
    const rows = await this.valuationRows(scope);
    let total = new Decimal(0);
    for (const r of rows) total = total.plus(r.totalValue);
    return { rows, totalValue: total.toFixed(4) };
  }

  // ── low stock / re-order (FR-RPT-022) ────────────────────────────────────────────────────────────
  async lowStock(scope: InventoryScope): Promise<StockValuationRow[]> {
    // The threshold is the report param (MAS holds no reorder attribute — see file header).
    const threshold = new Decimal(scope.reorderLevel ?? '0');
    const rows = await this.valuationRows(scope);
    return rows
      .filter((r) => new Decimal(r.quantityOnHand).lessThanOrEqualTo(threshold))
      .map((r) => ({ ...r, reorderLevel: threshold.toFixed(4) }));
  }

  /**
   * The (godown,item) valuation rows — INV's figures verbatim. With `asOf` set, the balance is the running
   * balance INV stamped on the LATEST `stock_movement` at/before the date (SRS edge 11: an item with no
   * movement before the date is simply absent → quantity/value 0). Without `asOf`, the live `stock_balance`.
   */
  private async valuationRows(scope: InventoryScope): Promise<StockValuationRow[]> {
    const m = this.manager();
    if (scope.asOf) {
      const params: unknown[] = [scope.companyId, scope.asOf];
      const conds = ['company_id = $1', 'voucher_date <= $2'];
      if (scope.godownId) {
        params.push(scope.godownId);
        conds.push(`godown_id = $${params.length}`);
      }
      if (scope.itemId) {
        params.push(scope.itemId);
        conds.push(`item_id = $${params.length}`);
      }
      const rows = await m.query(
        `SELECT DISTINCT ON (godown_id, item_id)
                godown_id, item_id,
                balance_qty_after::text   AS qty,
                balance_value_after::text AS value,
                avg_rate_after::text      AS rate
           FROM stock_movement
          WHERE ${conds.join(' AND ')}
          ORDER BY godown_id, item_id, voucher_date DESC, posted_at DESC, created_at DESC`,
        params,
      );
      return rows.map((r: Record<string, string | null>) => this.toValuationRow(r, scope.asOf ?? null));
    }

    const params: unknown[] = [scope.companyId];
    const conds = ['company_id = $1'];
    if (scope.godownId) {
      params.push(scope.godownId);
      conds.push(`godown_id = $${params.length}`);
    }
    if (scope.itemId) {
      params.push(scope.itemId);
      conds.push(`item_id = $${params.length}`);
    }
    const rows = await m.query(
      `SELECT godown_id, item_id,
              quantity_on_hand::text AS qty,
              total_value::text      AS value,
              avg_rate::text         AS rate
         FROM stock_balance
        WHERE ${conds.join(' AND ')}
        ORDER BY godown_id, item_id`,
      params,
    );
    return rows.map((r: Record<string, string | null>) => this.toValuationRow(r, null));
  }

  private toValuationRow(r: Record<string, string | null>, asOf: string | null): StockValuationRow {
    return {
      godownId: r.godown_id as string,
      itemId: r.item_id as string,
      quantityOnHand: new Decimal(r.qty ?? '0').toFixed(4),
      totalValue: new Decimal(r.value ?? '0').toFixed(4),
      weightedAverageRate: r.rate === null || r.rate === undefined ? null : new Decimal(r.rate).toFixed(4),
      reorderLevel: null,
      asOfDate: asOf,
    };
  }

  // ── stock-journal transfer / issue summary (FR-RPT-023) ──────────────────────────────────────────
  async movementSummary(scope: InventoryScope): Promise<PaginatedRows<StockMovementSummaryRow>> {
    const m = this.manager();
    const params: unknown[] = [scope.companyId, POSTED_STATUS];
    const conds = ['sj.company_id = $1', 'sj.status = $2', "sj.mode IN ('TRANSFER','ISSUE')"];
    const push = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.financialYearId) push('sj.financial_year_id = $$', scope.financialYearId);
    if (scope.itemId) push('sj.item_id = $$', scope.itemId);
    if (scope.godownId) {
      params.push(scope.godownId);
      conds.push(`(sj.from_godown_id = $${params.length} OR sj.to_godown_id = $${params.length})`);
    }
    if (scope.dateFrom) push('sj.voucher_date >= $$', scope.dateFrom);
    if (scope.dateTo) push('sj.voucher_date <= $$', scope.dateTo);
    // F4 project filter (stock_journal carries project_id).
    if (scope.projectIds !== null && scope.projectIds !== undefined) {
      if (scope.projectIds.length === 0) {
        conds.push('false');
      } else {
        params.push(scope.projectIds);
        conds.push(`sj.project_id = ANY($${params.length}::uuid[])`);
      }
    }
    const where = conds.join(' AND ');

    const [{ count }] = await m.query(`SELECT count(*)::text AS count FROM stock_journal sj WHERE ${where}`, params);
    const total = parseInt(count, 10);

    const { skip, take } = resolvePaging(scope);
    const rows = await m.query(
      `SELECT sj.id, sj.entry_no,
              to_char(sj.voucher_date,'YYYY-MM-DD') AS voucher_date,
              sj.from_godown_id, sj.to_godown_id, sj.item_id,
              sj.quantity::text AS quantity, sj.value::text AS value,
              sj.mode, sj.approved_by_id
         FROM stock_journal sj
        WHERE ${where}
        ORDER BY sj.voucher_date ASC, sj.entry_no ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return {
      items: rows.map((r: Record<string, string | null>) => ({
        stockJournalId: r.id as string,
        voucherNo: (r.entry_no as string) ?? null,
        voucherDate: r.voucher_date as string,
        fromGodownId: (r.from_godown_id as string) ?? null,
        toGodownId: (r.to_godown_id as string) ?? null,
        itemId: r.item_id as string,
        quantity: new Decimal(r.quantity ?? '0').toFixed(4),
        value: r.value === null || r.value === undefined ? null : new Decimal(r.value).toFixed(4),
        mode: r.mode as string,
        approverId: (r.approved_by_id as string) ?? null,
      })),
      total,
    };
  }
}
