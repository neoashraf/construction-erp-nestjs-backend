/**
 * Stock-ledger read port + row shapes (design §2.4 read side). The stock ledger is a PROJECTION of the
 * append-only stock_movement history (FR-INV-004) — never a stored balance the system trusts on its
 * own. These interfaces describe the read-only surface the `stock-ledger-query.service` exposes:
 *   - a `StockLedgerRow` per `(godown, item)` with quantity, total value, weighted-average rate;
 *   - the append-only `StockMovementRow` history for a `(godown, item)`, traced to its source voucher.
 *
 * PURE: strings only (money/qty serialised as Decimal(18,4) strings per the API contract, never JSON
 * numbers). The query service implements this straight from SQL over stock_movement (no aggregates).
 */
import { PageRequest, Paginated } from '../../../../infrastructure/http/pagination';
import { Actor } from '../../../../core/tenancy/tenant-context';

/** One computed stock-ledger row per `(godown, item)`. `weightedAverageRate` is null when qty is 0. */
export interface StockLedgerRow {
  godownId: string;
  itemId: string;
  quantityOnHand: string;
  totalValue: string;
  weightedAverageRate: string | null;
  asOfDate: string | null;
}

/** One append-only movement row (history), carrying its source voucher + the running snapshot after it. */
export interface StockMovementRow {
  id: string;
  godownId: string;
  itemId: string;
  sourceType: string;
  sourceId: string;
  direction: 'IN' | 'OUT';
  quantity: string;
  rate: string;
  value: string;
  balanceQtyAfter: string;
  balanceValueAfter: string;
  avgRateAfter: string | null;
  isReversal: boolean;
  reversalOf: string | null;
  voucherDate: string;
  postedAt: string;
}

export interface StockLedgerFilter extends PageRequest {
  godownId?: string;
  itemId?: string;
  projectId?: string;
  /** Balance as of the END of this voucherDate; default = latest. */
  asOfDate?: string;
}

export interface StockMovementFilter extends PageRequest {
  /** Required. */
  godownId: string;
  /** Required. */
  itemId: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface StockLedgerReadPort {
  stockLedger(filter: StockLedgerFilter, actor: Actor): Promise<Paginated<StockLedgerRow>>;
  movements(filter: StockMovementFilter, actor: Actor): Promise<Paginated<StockMovementRow>>;
}

export const STOCK_LEDGER_READ_PORT = Symbol('StockLedgerReadPort');
