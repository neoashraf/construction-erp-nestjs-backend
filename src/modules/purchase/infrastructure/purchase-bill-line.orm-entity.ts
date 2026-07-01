/**
 * PurchaseBillLineOrmEntity — the PUR `purchase_bill_line` table (INFRASTRUCTURE). One row per billed item
 * or non-stock expense line — stock XOR expense (item_id nullable, expense_account_id nullable, mutually
 * exclusive, enforced by a CHECK in the migration). Carries the four dimensions (godown required only on a
 * stock line) + the derived `received_qty` the GRN match reads. numeric(18,4) via moneyTransformer.
 */
import Decimal from 'decimal.js';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'purchase_bill_line' })
@Index('idx_purchase_bill_line_bill', ['purchaseBillId'])
export class PurchaseBillLineOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'purchase_bill_id', type: 'uuid' }) purchaseBillId!: string;
  @Column({ name: 'line_no', type: 'int' }) lineNo!: number;
  @Column({ name: 'item_id', type: 'uuid', nullable: true }) itemId!: string | null;
  @Column({ name: 'expense_account_id', type: 'uuid', nullable: true }) expenseAccountId!: string | null;
  @Column({ name: 'is_stock_line', type: 'boolean' }) isStockLine!: boolean;
  @Column({ name: 'billed_qty', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  billedQty!: Decimal;
  @Column({ name: 'rate', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  rate!: Decimal;
  @Column({ name: 'line_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  lineAmount!: Decimal;
  @Column({ name: 'vat_input_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  vatInputAmount!: Decimal;
  @Column({ name: 'tds_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  tdsAmount!: Decimal;
  @Column({ name: 'ait_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  aitAmount!: Decimal;
  @Column({ name: 'godown_id', type: 'uuid', nullable: true }) godownId!: string | null;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'purpose_id', type: 'uuid' }) purposeId!: string;
  @Column({ name: 'received_qty', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  receivedQty!: Decimal;
}
