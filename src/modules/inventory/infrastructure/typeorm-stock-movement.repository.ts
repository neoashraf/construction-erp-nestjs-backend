/**
 * TypeOrmStockMovementRepository (INFRASTRUCTURE) — the append-only writer + the LOCKED running-balance
 * read (design §5.4). Enrols in the active UnitOfWork via `getManager`. Uses INSERT (never save/update)
 * so the append-only trigger is never tripped. `currentBalanceForUpdate` upserts a zero stock_balance row
 * for the pair if missing, then `SELECT … FOR UPDATE`-locks it so a concurrent post of the same
 * `(godown, item)` serialises — the weighted average is never computed against stale state.
 *
 * Every method is `companyId`-scoped (F3). MUST be called inside a UnitOfWork for the lock to hold.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { StockMovement } from '../domain/stock-movement';
import { StockMovementRepository } from '../domain/ports/stock-movement.repository';
import { Balance } from '../domain/valuation';
import { StockMovementMapper } from './stock-movement.mapper';
import { StockMovementOrmEntity } from './stock-movement.orm-entity';

@Injectable()
export class TypeOrmStockMovementRepository implements StockMovementRepository {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async append(movement: StockMovement): Promise<void> {
    const manager = getManager(this.dataSource);
    const orm = StockMovementMapper.toOrm(movement);
    await manager.getRepository(StockMovementOrmEntity).insert(orm);

    // Upsert the stock_balance cache to this movement's snapshot (the row is already locked when the
    // post read it via currentBalanceForUpdate; for a brand-new pair we insert it here).
    await manager.query(
      `INSERT INTO stock_balance (id, company_id, godown_id, item_id, quantity_on_hand, total_value, avg_rate, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 1)
       ON CONFLICT (company_id, godown_id, item_id) DO UPDATE
         SET quantity_on_hand = EXCLUDED.quantity_on_hand,
             total_value      = EXCLUDED.total_value,
             avg_rate         = EXCLUDED.avg_rate,
             updated_at       = now(),
             version          = stock_balance.version + 1`,
      [
        this.ids.next(),
        movement.props.companyId,
        movement.props.godownId,
        movement.props.itemId,
        movement.props.balanceQtyAfter.toFixed(4),
        movement.props.balanceValueAfter.toFixed(4),
        movement.props.avgRateAfter == null ? null : movement.props.avgRateAfter.toFixed(4),
      ],
    );
  }

  async currentBalanceForUpdate(
    companyId: string,
    godownId: string,
    itemId: string,
  ): Promise<Balance> {
    const manager = getManager(this.dataSource);
    // Ensure the lock target exists, then take the row lock. ON CONFLICT DO NOTHING is idempotent;
    // the subsequent FOR UPDATE serialises concurrent posters of the same pair (design §5.4).
    await manager.query(
      `INSERT INTO stock_balance (id, company_id, godown_id, item_id, quantity_on_hand, total_value, avg_rate, updated_at, version)
         VALUES ($1, $2, $3, $4, 0, 0, NULL, now(), 1)
       ON CONFLICT (company_id, godown_id, item_id) DO NOTHING`,
      [this.ids.next(), companyId, godownId, itemId],
    );
    const rows: Array<{ quantity_on_hand: string; total_value: string }> = await manager.query(
      `SELECT quantity_on_hand::text AS quantity_on_hand, total_value::text AS total_value
         FROM stock_balance
        WHERE company_id = $1 AND godown_id = $2 AND item_id = $3
        FOR UPDATE`,
      [companyId, godownId, itemId],
    );
    const row = rows[0];
    return {
      qty: new Decimal(row.quantity_on_hand),
      value: new Decimal(row.total_value),
    };
  }

  async balanceAsOf(
    companyId: string,
    godownId: string,
    itemId: string,
    voucherDate: string,
  ): Promise<Balance> {
    const manager = getManager(this.dataSource);
    // The snapshot of the last movement <= date (design §7); ordered by voucher_date then posted_at.
    const rows: Array<{ balance_qty_after: string; balance_value_after: string }> =
      await manager.query(
        `SELECT balance_qty_after::text AS balance_qty_after, balance_value_after::text AS balance_value_after
           FROM stock_movement
          WHERE company_id = $1 AND godown_id = $2 AND item_id = $3 AND voucher_date <= $4
          ORDER BY voucher_date DESC, posted_at DESC
          LIMIT 1`,
        [companyId, godownId, itemId, voucherDate],
      );
    if (rows.length === 0) {
      return { qty: new Decimal(0), value: new Decimal(0) };
    }
    return {
      qty: new Decimal(rows[0].balance_qty_after),
      value: new Decimal(rows[0].balance_value_after),
    };
  }
}
