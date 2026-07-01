/**
 * PurchaseOrderLineOrmEntity — the PUR `purchase_order_line` table (INFRASTRUCTURE). One row per ordered
 * item; carries the four dimensions (project + cost_centre + purpose + godown, all required — SRS §8) plus
 * the derived `billed_qty`/`received_qty` roll-ups the PO->Bill->GRN match reads. numeric(18,4) via
 * moneyTransformer. FKs + CHECKs live in the migration.
 */
import Decimal from 'decimal.js';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'purchase_order_line' })
@Index('idx_purchase_order_line_po', ['purchaseOrderId'])
export class PurchaseOrderLineOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'purchase_order_id', type: 'uuid' }) purchaseOrderId!: string;
  @Column({ name: 'line_no', type: 'int' }) lineNo!: number;
  @Column({ name: 'item_id', type: 'uuid' }) itemId!: string;
  @Column({ name: 'ordered_qty', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  orderedQty!: Decimal;
  @Column({ name: 'rate', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  rate!: Decimal;
  @Column({ name: 'line_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  lineAmount!: Decimal;
  @Column({ name: 'godown_id', type: 'uuid' }) godownId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'purpose_id', type: 'uuid' }) purposeId!: string;
  @Column({ name: 'billed_qty', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  billedQty!: Decimal;
  @Column({ name: 'received_qty', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  receivedQty!: Decimal;
}
