/**
 * Weighted-average valuation — the SINGLE definition of how INV values stock (FR-INV-002/-003/-011).
 * PURE TypeScript: decimal.js only, no NestJS, no TypeORM, never a JS `number`/`parseFloat` on money.
 *
 * A `Balance` is a `(godown, item)` running position: `qty` units on hand carrying `value` total cost.
 * The weighted-average rate is `value / qty` (null when `qty = 0`). All three primitives here — receipt
 * roll, issue valuation, transfer-in — are exact Decimal, and are reused by PUR (receipt-in) and REQ
 * (issue-out) through the InventoryService port so valuation has exactly one definition (FR-INV-006).
 */
import Decimal from 'decimal.js';
import { NegativeStockError } from './errors';

/** Scale at which quantities, rates, values and balances are stored — numeric(18,4) (brief §4, design §7). */
export const INV_SCALE = 4;

/** A `(godown, item)` running balance. `qty`/`value` are exact Decimals; the average is `value/qty`. */
export interface Balance {
  readonly qty: Decimal;
  readonly value: Decimal;
}

/** The outcome of valuing an issue/transfer-out at the current source weighted-average rate. */
export interface IssueResult {
  /** `qty × currentAverageRate`, rounded to INV_SCALE. */
  readonly issuedValue: Decimal;
  /** The current weighted-average rate the issue was valued at (0 when the source is empty). */
  readonly rate: Decimal;
  /** The reduced source balance after the issue (may go negative when `allowNegative`). */
  readonly newBalance: Balance;
}

/** A zero balance for an empty `(godown, item)`. */
export function emptyBalance(): Balance {
  return { qty: new Decimal(0), value: new Decimal(0) };
}

/** `value / qty`, rounded to INV_SCALE; `null` when `qty = 0` (FR-INV-004). */
export function averageRate(b: Balance): Decimal | null {
  if (b.qty.isZero()) return null;
  return b.value.dividedBy(b.qty).toDecimalPlaces(INV_SCALE, Decimal.ROUND_HALF_UP);
}

/**
 * Receipt-in of `qty` at `rate`: the new average becomes `(oldValue + qty×rate) / (oldQty + qty)`
 * (FR-INV-002). Returns the new running balance; `value` accumulates the exact `qty×rate` at INV_SCALE.
 * First receipt into an empty godown sets the average to its own rate. `qty` and `rate` must be > 0 / ≥ 0.
 */
export function applyReceipt(prev: Balance, qty: Decimal, rate: Decimal): Balance {
  assertPositive(qty, 'quantity');
  assertNonNegative(rate, 'rate');
  const addedValue = qty.times(rate).toDecimalPlaces(INV_SCALE, Decimal.ROUND_HALF_UP);
  return {
    qty: prev.qty.plus(qty),
    value: prev.value.plus(addedValue),
  };
}

/**
 * Value an issue / transfer-out at the CURRENT source weighted-average rate (FR-INV-003): the issued
 * value is `qty × (prev.value / prev.qty)`. Throws `NegativeStockError` when `qty > prev.qty` and
 * `allowNegative` is false (FR-INV-014/-015). When allowed, it proceeds and the balance may go negative.
 *
 * The issued value is computed as `qty × averageRate` and rounded to INV_SCALE; the new balance's value
 * is `prev.value − issuedValue`, keeping the ledger consumption and the movement byte-for-byte identical
 * (the reconciliation invariant, FR-INV-005/-011). Issuing the whole balance zeroes both qty and value.
 */
export function valueIssue(
  prev: Balance,
  qty: Decimal,
  opts: { allowNegative: boolean },
): IssueResult {
  assertPositive(qty, 'quantity');
  if (qty.greaterThan(prev.qty) && !opts.allowNegative) {
    throw new NegativeStockError(prev.qty, qty);
  }
  const rate = prev.qty.isZero()
    ? new Decimal(0)
    : prev.value.dividedBy(prev.qty).toDecimalPlaces(INV_SCALE, Decimal.ROUND_HALF_UP);

  // Value the issue as q·(value/qty) in one expression (FR-INV-003) — do NOT round the rate first, so
  // the issued value matches the design's exact figure and the reconciliation invariant holds.
  // Issuing the entire balance drains value to exactly zero (no rounding dust left behind).
  const drainsAll = qty.equals(prev.qty);
  const issuedValue = drainsAll
    ? prev.value
    : prev.qty.isZero()
      ? new Decimal(0)
      : qty.times(prev.value).dividedBy(prev.qty).toDecimalPlaces(INV_SCALE, Decimal.ROUND_HALF_UP);

  return {
    issuedValue,
    rate,
    newBalance: {
      qty: prev.qty.minus(qty),
      value: prev.value.minus(issuedValue),
    },
  };
}

/**
 * Transfer-in: receive `qty` at the value that LEFT the source (`incomingValue`), so a transfer is
 * value-neutral across the two godowns and changes only the receiver's weighted average (FR-INV-011).
 * The receiver's rate is re-rolled implicitly (its new average = new value / new qty).
 */
export function applyTransferIn(prev: Balance, qty: Decimal, incomingValue: Decimal): Balance {
  assertPositive(qty, 'quantity');
  assertNonNegative(incomingValue, 'value');
  return {
    qty: prev.qty.plus(qty),
    value: prev.value.plus(incomingValue),
  };
}

function assertPositive(v: Decimal, name: string): void {
  if (!v.greaterThan(0)) {
    throw new RangeError(`${name} must be > 0 (got ${v.toString()})`);
  }
}

function assertNonNegative(v: Decimal, name: string): void {
  if (v.isNegative()) {
    throw new RangeError(`${name} must be >= 0 (got ${v.toString()})`);
  }
}
