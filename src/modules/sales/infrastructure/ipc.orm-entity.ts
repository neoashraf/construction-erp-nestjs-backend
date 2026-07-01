/**
 * IpcOrmEntity — the SAL `sales_invoice` voucher table (INFRASTRUCTURE). SAL owns only this voucher row;
 * the posted ledger entry is LED's (linked by journal_entry_id, null until posted). Money/rate columns
 * are numeric(18,4) via moneyTransformer (string ↔ Decimal, exact — never float). The
 * (company_id, project_id, ipc_seq_no) unique index, the currently_due_amount>=0 / certified_amount>0
 * CHECKs, FKs (ON DELETE RESTRICT), and the §7 indexes live in the migration.
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

@Entity({ name: 'sales_invoice' })
@Index('idx_sales_invoice_company_fy', ['companyId', 'financialYearId'])
@Index('idx_sales_invoice_company_status', ['companyId', 'status'])
@Index('idx_sales_invoice_customer', ['customerId'])
@Index('idx_sales_invoice_journal_entry', ['journalEntryId'])
@Index('idx_sales_invoice_entry_no', ['entryNo'])
export class IpcOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'customer_id', type: 'uuid' }) customerId!: string;
  @Column({ name: 'ipc_seq_no', type: 'int' }) ipcSeqNo!: number;
  @Column({ name: 'ipc_date', type: 'date' }) ipcDate!: string;
  @Column({ name: 'bill_date', type: 'date' }) billDate!: string;
  @Column({ name: 'due_date', type: 'date' }) dueDate!: string;
  @Column({ name: 'work_completed_pct', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  workCompletedPct!: Decimal;
  @Column({ name: 'certified_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  certifiedAmount!: Decimal;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'purpose_id', type: 'uuid' }) purposeId!: string;
  @Column({ name: 'output_vat_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  outputVatAmount!: Decimal;
  @Column({ name: 'ait_tds_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  aitTdsAmount!: Decimal;
  @Column({ name: 'retention_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  retentionAmount!: Decimal;
  @Column({ name: 'advance_recovered_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  advanceRecoveredAmount!: Decimal;
  @Column({ name: 'currently_due_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  currentlyDueAmount!: Decimal;
  @Column({ name: 'retention_rate_pct', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  retentionRatePct!: Decimal;
  @Column({ name: 'advance_rate_pct', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  advanceRatePct!: Decimal;
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
