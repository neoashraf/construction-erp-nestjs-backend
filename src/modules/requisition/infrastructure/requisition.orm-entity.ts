/**
 * RequisitionOrmEntity — the REQ `requisition` header table (INFRASTRUCTURE). REQ owns this workflow
 * document; it owns NO stock_movement / journal_* table (those are INV/LED, referenced only at issue —
 * brief 2). Money/qty columns are numeric(18,4) via moneyTransformer (string ↔ Decimal, exact — never
 * float). status/priority/approval_tier are app-checked varchar (adding a value = code, not ALTER TYPE).
 * The CHECKs, FKs (ON DELETE RESTRICT), and the §7 indexes live in the migration.
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

@Entity({ name: 'requisition' })
@Index('idx_requisition_company_status_reqdate', ['companyId', 'status', 'requiredDate'])
@Index('idx_requisition_company_project', ['companyId', 'projectId'])
@Index('idx_requisition_company_submitted_by', ['companyId', 'submittedById'])
export class RequisitionOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'requisition_no', type: 'varchar', nullable: true }) requisitionNo!: string | null;
  @Column({ name: 'requisition_seq', type: 'int', nullable: true }) requisitionSeq!: number | null;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'purpose_id', type: 'uuid' }) purposeId!: string;
  @Column({ name: 'from_godown_id', type: 'uuid', nullable: true }) fromGodownId!: string | null;
  @Column({ name: 'required_date', type: 'date' }) requiredDate!: string;
  @Column({ name: 'priority', type: 'varchar' }) priority!: string;
  @Column({ name: 'status', type: 'varchar' }) status!: string;
  @Column({ name: 'estimated_value', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  estimatedValue!: Decimal;
  @Column({ name: 'approval_tier', type: 'varchar', nullable: true }) approvalTier!: string | null;
  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true }) submittedAt!: Date | null;
  @Column({ name: 'submitted_by_id', type: 'uuid', nullable: true }) submittedById!: string | null;
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true }) closedAt!: Date | null;
  @Column({ name: 'closed_reason', type: 'text', nullable: true }) closedReason!: string | null;
  @Column({ name: 'narration', type: 'text', nullable: true }) narration!: string | null;
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
