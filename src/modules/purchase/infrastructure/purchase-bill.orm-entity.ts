/**
 * PurchaseBillOrmEntity — the PUR `purchase_bill` voucher table (INFRASTRUCTURE). PUR owns only this
 * voucher row; the posted ledger entry is LED's (linked by journal_entry_id, null until posted); the
 * inventory movements are INV's (referenced only via stock_movement.source_id=bill/line id, no FK from
 * this table). Money columns are numeric(18,4) via moneyTransformer (string <-> Decimal, exact — never
 * float). The `net_payable_amount >= 0` / `gross_amount >= 0` CHECKs, FKs (ON DELETE RESTRICT), and the §7
 * indexes live in the migration.
 */
import Decimal from 'decimal.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'purchase_bill' })
@Index('idx_purchase_bill_company_status_date', ['companyId', 'status', 'billDate'])
@Index('idx_purchase_bill_company_fy', ['companyId', 'financialYearId'])
@Index('idx_purchase_bill_supplier', ['companyId', 'supplierId'])
@Index('idx_purchase_bill_project', ['companyId', 'projectId'])
@Index('idx_purchase_bill_purchase_order', ['purchaseOrderId'])
@Index('idx_purchase_bill_journal_entry', ['journalEntryId'])
@Index('idx_purchase_bill_entry_no', ['entryNo'])
export class PurchaseBillOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'supplier_id', type: 'uuid' }) supplierId!: string;
  @Column({ name: 'purchase_order_id', type: 'uuid', nullable: true }) purchaseOrderId!: string | null;
  @Column({ name: 'supplier_invoice_ref', type: 'varchar', nullable: true }) supplierInvoiceRef!: string | null;
  @Column({ name: 'bill_date', type: 'date' }) billDate!: string;
  @Column({ name: 'due_date', type: 'date' }) dueDate!: string;
  @Column({ name: 'gross_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  grossAmount!: Decimal;
  @Column({ name: 'vat_input_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  vatInputAmount!: Decimal;
  @Column({ name: 'tds_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  tdsAmount!: Decimal;
  @Column({ name: 'ait_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  aitAmount!: Decimal;
  @Column({ name: 'net_payable_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  netPayableAmount!: Decimal;
  @Column({ name: 'narration', type: 'text', nullable: true }) narration!: string | null;
  @Column({ name: 'status', type: 'varchar' }) status!: string;
  @Column({ name: 'entry_no', type: 'varchar', nullable: true }) entryNo!: string | null;
  @Column({ name: 'journal_entry_id', type: 'uuid', nullable: true }) journalEntryId!: string | null;
  @Column({ name: 'posted_at', type: 'timestamptz', nullable: true }) postedAt!: Date | null;
  @Column({ name: 'posted_by', type: 'uuid', nullable: true }) postedBy!: string | null;
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
