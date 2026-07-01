/**
 * StockMovementMapper (INFRASTRUCTURE) — translates the pure `StockMovement` domain entity ↔ the
 * `stock_movement` ORM row. The domain never imports TypeORM; this is the only seam between them.
 */
import Decimal from 'decimal.js';
import {
  MovementDirection,
  MovementSourceType,
  StockMovement,
} from '../domain/stock-movement';
import { StockMovementOrmEntity } from './stock-movement.orm-entity';

export const StockMovementMapper = {
  toOrm(m: StockMovement): StockMovementOrmEntity {
    const e = new StockMovementOrmEntity();
    e.id = m.id;
    e.companyId = m.props.companyId;
    e.godownId = m.props.godownId;
    e.itemId = m.props.itemId;
    e.sourceType = m.props.sourceType;
    e.sourceId = m.props.sourceId;
    e.direction = m.props.direction;
    e.quantity = m.props.quantity;
    e.rate = m.props.rate;
    e.value = m.props.value;
    e.balanceQtyAfter = m.props.balanceQtyAfter;
    e.balanceValueAfter = m.props.balanceValueAfter;
    e.avgRateAfter = m.props.avgRateAfter;
    e.isReversal = m.props.isReversal;
    e.reversalOf = m.props.reversalOf;
    e.voucherDate = m.props.voucherDate;
    e.postedAt = m.props.postedAt;
    e.postedBy = m.props.postedBy;
    return e;
  },

  toDomain(e: StockMovementOrmEntity): StockMovement {
    return StockMovement.rehydrate(e.id, {
      companyId: e.companyId,
      godownId: e.godownId,
      itemId: e.itemId,
      sourceType: e.sourceType as MovementSourceType,
      sourceId: e.sourceId,
      direction: e.direction as MovementDirection,
      quantity: new Decimal(e.quantity),
      rate: new Decimal(e.rate),
      value: new Decimal(e.value),
      balanceQtyAfter: new Decimal(e.balanceQtyAfter),
      balanceValueAfter: new Decimal(e.balanceValueAfter),
      avgRateAfter: e.avgRateAfter == null ? null : new Decimal(e.avgRateAfter),
      isReversal: e.isReversal,
      reversalOf: e.reversalOf,
      voucherDate: e.voucherDate,
      postedAt: e.postedAt,
      postedBy: e.postedBy,
    });
  },
};
