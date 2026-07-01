/**
 * StockMovement — the append-only fact the stock ledger is projected from (SRS §8, design §3.2). PURE
 * TypeScript: decimal.js only, no NestJS/TypeORM. A movement is written ONCE at post and never updated
 * or deleted (the DB append-only trigger enforces this at the storage layer, FR-INV-020); a reversal
 * writes a NEW mirrored movement (`isReversal=true`, `reversalOf=<original>`, opposite `direction`).
 *
 * `quantity` is always > 0 — the sign comes from `direction` (`IN` increases, `OUT` decreases). The
 * `balance*After` fields are the denormalised running snapshot after this movement (a cache for fast
 * as-of reads; always recomputable from the ordered history — FR-INV-004).
 */
import Decimal from 'decimal.js';
import { Entity } from '../../../common/domain/domain';
import { Balance } from './valuation';

export type MovementDirection = 'IN' | 'OUT';

/** Where a movement originated — a Stock Journal (INV), a goods-receipt (PUR) or a requisition issue (REQ). */
export type MovementSourceType = 'STOCK_JOURNAL' | 'GRN' | 'REQ_ISSUE';

export interface StockMovementProps {
  readonly companyId: string;
  readonly godownId: string;
  readonly itemId: string;
  readonly sourceType: MovementSourceType;
  readonly sourceId: string;
  readonly direction: MovementDirection;
  readonly quantity: Decimal;
  readonly rate: Decimal;
  readonly value: Decimal;
  readonly balanceQtyAfter: Decimal;
  readonly balanceValueAfter: Decimal;
  readonly avgRateAfter: Decimal | null;
  readonly isReversal: boolean;
  readonly reversalOf: string | null;
  readonly voucherDate: string;
  readonly postedAt: Date;
  readonly postedBy: string;
}

export interface NewStockMovement {
  readonly companyId: string;
  readonly godownId: string;
  readonly itemId: string;
  readonly sourceType: MovementSourceType;
  readonly sourceId: string;
  readonly direction: MovementDirection;
  readonly quantity: Decimal;
  readonly rate: Decimal;
  readonly value: Decimal;
  /** The running `(godown, item)` balance AFTER applying this movement (snapshot). */
  readonly balanceAfter: Balance;
  readonly isReversal?: boolean;
  readonly reversalOf?: string | null;
  readonly voucherDate: string;
  readonly postedBy: string;
}

export class StockMovement extends Entity<string> {
  private constructor(
    id: string,
    readonly props: StockMovementProps,
  ) {
    super(id);
  }

  /**
   * Build a movement from a computed post outcome. Validates `quantity > 0` and `value >= 0` (the DB
   * CHECKs mirror this); the sign of the effect lives in `direction`, never a negative quantity.
   */
  static create(input: NewStockMovement, id: string, postedAt: Date): StockMovement {
    if (!input.quantity.greaterThan(0)) {
      throw new RangeError(`stock movement quantity must be > 0 (got ${input.quantity.toString()})`);
    }
    if (input.value.isNegative()) {
      throw new RangeError(`stock movement value must be >= 0 (got ${input.value.toString()})`);
    }
    const avg = input.balanceAfter.qty.isZero()
      ? null
      : input.balanceAfter.value.dividedBy(input.balanceAfter.qty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    return new StockMovement(id, {
      companyId: input.companyId,
      godownId: input.godownId,
      itemId: input.itemId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      direction: input.direction,
      quantity: input.quantity,
      rate: input.rate,
      value: input.value,
      balanceQtyAfter: input.balanceAfter.qty,
      balanceValueAfter: input.balanceAfter.value,
      avgRateAfter: avg,
      isReversal: input.isReversal ?? false,
      reversalOf: input.reversalOf ?? null,
      voucherDate: input.voucherDate,
      postedAt,
      postedBy: input.postedBy,
    });
  }

  /** Rehydrate a persisted movement (used by the mapper on read). */
  static rehydrate(id: string, props: StockMovementProps): StockMovement {
    return new StockMovement(id, props);
  }

  /** The signed quantity effect on the `(godown, item)` balance: +qty for IN, −qty for OUT. */
  signedQuantity(): Decimal {
    return this.props.direction === 'IN' ? this.props.quantity : this.props.quantity.negated();
  }

  /** The signed value effect: +value for IN, −value for OUT. */
  signedValue(): Decimal {
    return this.props.direction === 'IN' ? this.props.value : this.props.value.negated();
  }
}
