/**
 * RequisitionLineOrmEntity — the REQ `requisition_line` table (INFRASTRUCTURE). One requested material per
 * row: requested/issued/balance quantities (numeric(18,4), exact) with the DB balance-invariant CHECK
 * `issued + balance = requested` (FR-REQ-018) declared in the migration. At draft issued = 0, balance =
 * requested; only brief 2's issue mutates them. indicative_rate is the estimate rate (informational, not
 * posted). item FK ON DELETE RESTRICT + the partial-balance index live in the migration.
 */
import Decimal from 'decimal.js';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'requisition_line' })
@Index('idx_requisition_line_requisition', ['requisitionId'])
export class RequisitionLineOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'requisition_id', type: 'uuid' }) requisitionId!: string;
  @Column({ name: 'line_no', type: 'int' }) lineNo!: number;
  @Column({ name: 'item_id', type: 'uuid' }) itemId!: string;
  @Column({ name: 'requested_quantity', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  requestedQuantity!: Decimal;
  @Column({ name: 'issued_quantity', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  issuedQuantity!: Decimal;
  @Column({ name: 'balance_quantity', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  balanceQuantity!: Decimal;
  @Column({
    name: 'indicative_rate',
    type: 'numeric',
    precision: 18,
    scale: 4,
    nullable: true,
    transformer: moneyTransformer,
  })
  indicativeRate!: Decimal | null;
  @Column({ name: 'uom', type: 'varchar' }) uom!: string;
}
