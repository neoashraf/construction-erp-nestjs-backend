/**
 * StockMovementOrmEntity — `stock_movement` row (INFRASTRUCTURE). Append-only: NO deleted_at / version /
 * updated_at column — a movement is written once and never mutated (the migration's BEFORE UPDATE OR
 * DELETE trigger enforces it, FR-INV-020). `quantity`/`rate`/`value`/`balance*_after` are numeric(18,4)
 * via `moneyTransformer` (string ↔ Decimal — exact money, never float). CHECKs, the append-only trigger,
 * FKs (ON DELETE RESTRICT) and the §7 indexes live in the migration; the ORM only ever INSERTs.
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import Decimal from 'decimal.js';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'stock_movement' })
@Index('idx_stock_movement_dim_date', ['companyId', 'godownId', 'itemId', 'voucherDate'])
@Index('idx_stock_movement_latest', ['godownId', 'itemId', 'postedAt'])
@Index('idx_stock_movement_source', ['sourceType', 'sourceId'])
@Index('idx_stock_movement_reversal_of', ['reversalOf'])
export class StockMovementOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'godown_id', type: 'uuid' })
  godownId!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ name: 'source_type', type: 'varchar' })
  sourceType!: string;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId!: string;

  @Column({ name: 'direction', type: 'varchar' })
  direction!: string;

  @Column({ name: 'quantity', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  quantity!: Decimal;

  @Column({ name: 'rate', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  rate!: Decimal;

  @Column({ name: 'value', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  value!: Decimal;

  @Column({ name: 'balance_qty_after', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  balanceQtyAfter!: Decimal;

  @Column({ name: 'balance_value_after', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  balanceValueAfter!: Decimal;

  @Column({
    name: 'avg_rate_after',
    type: 'numeric',
    precision: 18,
    scale: 4,
    nullable: true,
    transformer: moneyTransformer,
  })
  avgRateAfter!: Decimal | null;

  @Column({ name: 'is_reversal', type: 'boolean', default: false })
  isReversal!: boolean;

  @Column({ name: 'reversal_of', type: 'uuid', nullable: true })
  reversalOf!: string | null;

  @Column({ name: 'voucher_date', type: 'date' })
  voucherDate!: string;

  @Column({ name: 'posted_at', type: 'timestamptz' })
  postedAt!: Date;

  @Column({ name: 'posted_by', type: 'uuid' })
  postedBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
