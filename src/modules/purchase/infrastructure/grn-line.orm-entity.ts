/**
 * GrnLineOrmEntity — the PUR `grn_line` table (INFRASTRUCTURE). One row per physically received item:
 * received_qty (> 0, CHECK in the migration), rate + received_value (numeric(18,4) via moneyTransformer),
 * the receiving godown + the four dimensions (informational, mirroring the referenced bill line), the
 * optional `purchase_bill_line_id` partial-receipt reference (FR-PUR-018), and the `match_status`
 * snapshotted at post (FR-PUR-017). No stock/ledger reference columns — option (a), §10 Q4 (domain/grn.ts).
 */
import Decimal from 'decimal.js';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'grn_line' })
@Index('idx_grn_line_grn', ['grnId'])
@Index('idx_grn_line_bill_line', ['purchaseBillLineId'])
export class GrnLineOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'grn_id', type: 'uuid' }) grnId!: string;
  @Column({ name: 'line_no', type: 'int' }) lineNo!: number;
  @Column({ name: 'purchase_bill_line_id', type: 'uuid', nullable: true }) purchaseBillLineId!: string | null;
  @Column({ name: 'item_id', type: 'uuid' }) itemId!: string;
  @Column({ name: 'received_qty', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  receivedQty!: Decimal;
  @Column({ name: 'rate', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  rate!: Decimal;
  @Column({ name: 'received_value', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  receivedValue!: Decimal;
  @Column({ name: 'godown_id', type: 'uuid' }) godownId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'purpose_id', type: 'uuid' }) purposeId!: string;
  @Column({ name: 'match_status', type: 'varchar', nullable: true }) matchStatus!: string | null;
}
