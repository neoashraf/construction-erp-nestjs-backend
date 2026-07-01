/**
 * StockBalanceOrmEntity — `stock_balance` row (INFRASTRUCTURE). The per-`(company, godown, item)` lock +
 * cache target (design §5.4, §7): `quantity_on_hand`/`total_value`/`avg_rate` at numeric(18,4), updated
 * inside each post under `SELECT … FOR UPDATE`. It is a DERIVED cache — always recomputable from
 * stock_movement — never the sole source of truth (FR-INV-004). UNIQUE on the triple (in the migration).
 * `@VersionColumn` gives an extra optimistic guard alongside the row lock.
 */
import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';
import Decimal from 'decimal.js';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'stock_balance' })
@Index('uq_stock_balance_triple', ['companyId', 'godownId', 'itemId'], { unique: true })
export class StockBalanceOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'godown_id', type: 'uuid' })
  godownId!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ name: 'quantity_on_hand', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  quantityOnHand!: Decimal;

  @Column({ name: 'total_value', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  totalValue!: Decimal;

  @Column({
    name: 'avg_rate',
    type: 'numeric',
    precision: 18,
    scale: 4,
    nullable: true,
    transformer: moneyTransformer,
  })
  avgRate!: Decimal | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @VersionColumn({ name: 'version', type: 'int' })
  version!: number;
}
