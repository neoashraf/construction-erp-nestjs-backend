/**
 * PurchaseOrderOrmEntity — the PUR `purchase_order` header table (INFRASTRUCTURE). A NON-POSTING
 * commitment document: owns no journal_entry_id, no entry_no (FR-PUR-001). Money/qty columns are
 * numeric(18,4) via moneyTransformer (string <-> Decimal, exact — never float). `status` is an app-checked
 * varchar. The CHECKs, FKs (ON DELETE RESTRICT), and the §7 indexes live in the migration.
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

@Entity({ name: 'purchase_order' })
@Index('idx_purchase_order_company_status', ['companyId', 'status'])
@Index('idx_purchase_order_supplier', ['supplierId'])
@Index('idx_purchase_order_project', ['projectId'])
export class PurchaseOrderOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'supplier_id', type: 'uuid' }) supplierId!: string;
  @Column({ name: 'po_ref_no', type: 'varchar', nullable: true }) poRefNo!: string | null;
  @Column({ name: 'po_date', type: 'date' }) poDate!: string;
  @Column({ name: 'expected_delivery_date', type: 'date', nullable: true }) expectedDeliveryDate!: string | null;
  @Column({ name: 'status', type: 'varchar' }) status!: string;
  @Column({ name: 'narration', type: 'text', nullable: true }) narration!: string | null;
  @Column({ name: 'approved_by', type: 'uuid', nullable: true }) approvedBy!: string | null;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true }) approvedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
