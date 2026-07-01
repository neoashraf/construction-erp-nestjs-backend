/**
 * StockMovementRepository — driven PORT (pure interface). Append-only writes + the LOCKED running-
 * balance read that serialises the weighted-average re-roll (design §2.5, §5.4). The adapter enrols in
 * the active UnitOfWork transaction. Every method is `companyId`-scoped (F3): a query without the
 * company is a cross-tenant leak.
 *
 * NOTE: the write path (`append`) and the locked read (`currentBalanceForUpdate`) exist for brief 2's
 * voucher post + brief 3's PUR/REQ integration; brief 1 ships the port + adapter and exercises the
 * locked re-roll and append-only trigger against real Postgres, but exposes no HTTP write endpoint.
 */
import { StockMovement } from '../stock-movement';
import { Balance } from '../valuation';

export interface StockMovementRepository {
  /**
   * Append one movement (INSERT only — never UPDATE/save, so the append-only trigger is never tripped)
   * and upsert the `(company, godown, item)` stock_balance cache row to the movement's snapshot.
   */
  append(movement: StockMovement): Promise<void>;

  /**
   * The `(godown, item)` running balance under a `SELECT … FOR UPDATE` lock on the stock_balance row
   * (design §5.4): a concurrent post of the same pair blocks until this transaction commits, so the
   * weighted average is never computed against stale state. Returns a zero balance for a pair with no
   * movements yet (locking the row it will create). MUST be called inside a UnitOfWork.
   */
  currentBalanceForUpdate(companyId: string, godownId: string, itemId: string): Promise<Balance>;

  /**
   * The `(godown, item)` balance as of the END of `voucherDate` — the snapshot of the last movement
   * with `voucher_date <= date` (FR-INV-021). Returns a zero balance when there is no such movement.
   * A plain read (no lock).
   */
  balanceAsOf(
    companyId: string,
    godownId: string,
    itemId: string,
    voucherDate: string,
  ): Promise<Balance>;
}

export const STOCK_MOVEMENT_REPOSITORY = Symbol('StockMovementRepository');
