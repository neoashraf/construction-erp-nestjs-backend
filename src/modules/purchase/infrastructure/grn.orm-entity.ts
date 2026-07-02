/**
 * GrnOrmEntity — the PUR `grn` voucher table (INFRASTRUCTURE). The physical-receipt record header. Under
 * the RESOLVED §10 Q4 option (a) (see domain/grn.ts) a GRN references NO journal_entry and NO
 * stock_movement — there are deliberately no such columns: the bill carries the receipt; the GRN is
 * informational (match status + registers). Status checked varchar (DRAFT|POSTED|CANCELLED); FKs
 * (ON DELETE RESTRICT) + indexes live in the migration (1700002100000-CreatePurchaseGrn).
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity({ name: 'grn' })
@Index('idx_grn_company_status_date', ['companyId', 'status', 'receiptDate'])
@Index('idx_grn_supplier', ['companyId', 'supplierId'])
@Index('idx_grn_project', ['companyId', 'projectId'])
@Index('idx_grn_purchase_bill', ['purchaseBillId'])
@Index('idx_grn_purchase_order', ['purchaseOrderId'])
export class GrnOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'supplier_id', type: 'uuid' }) supplierId!: string;
  @Column({ name: 'purchase_order_id', type: 'uuid', nullable: true }) purchaseOrderId!: string | null;
  @Column({ name: 'purchase_bill_id', type: 'uuid', nullable: true }) purchaseBillId!: string | null;
  @Column({ name: 'grn_ref_no', type: 'varchar', nullable: true }) grnRefNo!: string | null;
  @Column({ name: 'receipt_date', type: 'date' }) receiptDate!: string;
  @Column({ name: 'status', type: 'varchar' }) status!: string;
  @Column({ name: 'received_by', type: 'uuid', nullable: true }) receivedBy!: string | null;
  @Column({ name: 'narration', type: 'text', nullable: true }) narration!: string | null;
  @Column({ name: 'posted_at', type: 'timestamptz', nullable: true }) postedAt!: Date | null;
  @Column({ name: 'posted_by', type: 'uuid', nullable: true }) postedBy!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
