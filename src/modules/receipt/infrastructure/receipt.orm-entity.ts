/**
 * ReceiptOrmEntity — the REC `receipt` voucher table (INFRASTRUCTURE). REC owns only this voucher row;
 * the posted ledger entry is LED's (linked by journal_entry_id, null until posted). Money columns are
 * numeric(18,4) via moneyTransformer (string <-> Decimal, exact — never float). The composition CHECK
 * (amount_settled = cash_received + tax_deducted_at_source), the reference-XOR CHECK, the cheque-ref
 * CHECK, FKs (ON DELETE RESTRICT incl. ipc_id -> sales_invoice, journal_entry_id -> journal_entry), and
 * the §7 indexes live in the migration.
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

@Entity({ name: 'receipt' })
@Index('idx_receipt_company_fy', ['companyId', 'financialYearId'])
@Index('idx_receipt_company_status', ['companyId', 'status'])
@Index('idx_receipt_company_ipc', ['companyId', 'ipcId'])
@Index('idx_receipt_party', ['partyId'])
@Index('idx_receipt_company_project', ['companyId', 'projectId'])
@Index('idx_receipt_journal_entry', ['journalEntryId'])
@Index('idx_receipt_entry_no', ['entryNo'])
export class ReceiptOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'receipt_type', type: 'varchar' }) receiptType!: string;
  @Column({ name: 'receipt_date', type: 'date' }) receiptDate!: string;
  @Column({ name: 'payment_mode', type: 'varchar' }) paymentMode!: string;
  @Column({ name: 'deposit_account_id', type: 'uuid' }) depositAccountId!: string;
  @Column({ name: 'party_id', type: 'uuid' }) partyId!: string;
  @Column({ name: 'project_id', type: 'uuid', nullable: true }) projectId!: string | null;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'purpose_id', type: 'uuid', nullable: true }) purposeId!: string | null;
  @Column({ name: 'ipc_id', type: 'uuid', nullable: true }) ipcId!: string | null;
  @Column({ name: 'general_target_account_id', type: 'uuid', nullable: true }) generalTargetAccountId!:
    | string
    | null;
  @Column({ name: 'amount_settled', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  amountSettled!: Decimal;
  @Column({ name: 'cash_received', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  cashReceived!: Decimal;
  @Column({ name: 'tax_deducted_at_source', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  taxDeductedAtSource!: Decimal;
  @Column({ name: 'cheque_txn_ref', type: 'varchar', nullable: true }) chequeTxnRef!: string | null;
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
