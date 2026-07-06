/**
 * InventoryReadPort (RPT · FR-RPT-021/-022/-023) — PURE domain port. The seam to INV's stock-ledger read
 * surface. RPT depends on this by interface; the adapter (infrastructure) runs scoped SELECTs over INV's
 * `stock_balance` snapshot / `stock_movement` running balances (stock valuation & low-stock) and the
 * `stock_journal` header (transfer/issue summary). RPT reads INV's OWN projection — it NEVER recomputes
 * valuation (FR-RPT-004; INV FR-INV-004/-005). Company is always on the query (F3); every method is a
 * non-blocking SELECT/aggregate — no write, no PostingService.
 */
import { PaginatedRows } from './ledger.read.port';
import { StockMovementSummaryRow, StockValuationRow } from '../report-result.model';

export const INVENTORY_READ_PORT = Symbol('INVENTORY_READ_PORT');

export interface InventoryScope {
  companyId: string;
  /** F4 project filter for the movement/transfer summary (stock has no project on the balance). */
  projectIds?: string[] | null;
  godownId?: string;
  itemId?: string;
  financialYearId?: string;
  /** As-of valuation date; when set, the balance is read from INV's stock_movement running balance. */
  asOf?: string;
  /** Low-stock threshold — the report param where MAS holds no reorder attribute (FR-RPT-022, §15). */
  reorderLevel?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface InventoryReadPort {
  /** Stock valuation per (godown,item) with a reconciling total value (FR-RPT-021). */
  stockValuation(scope: InventoryScope): Promise<{ rows: StockValuationRow[]; totalValue: string }>;
  /** (godown,item) rows whose quantity on hand is at or below the re-order level (FR-RPT-022). */
  lowStock(scope: InventoryScope): Promise<StockValuationRow[]>;
  /** Posted Stock Journal transfers/issues over a date range (FR-RPT-023). */
  movementSummary(scope: InventoryScope): Promise<PaginatedRows<StockMovementSummaryRow>>;
}
