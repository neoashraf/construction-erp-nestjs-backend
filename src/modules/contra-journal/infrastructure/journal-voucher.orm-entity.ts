/**
 * JournalVoucherOrmEntity + JournalLineDraftOrmEntity — the GEN `journal_voucher` / `journal_line_draft`
 * DRAFT tables (INFRASTRUCTURE). The line table is named `journal_line_draft` to avoid colliding with
 * LED's posted `journal_line`. Money is numeric(18,4) via moneyTransformer. The partial-unique
 * one-opening-per-company index, CHECKs, FKs (ON DELETE RESTRICT), and indexes live in the migration.
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

@Entity({ name: 'journal_voucher' })
@Index('idx_journal_voucher_company_status', ['companyId', 'status'])
@Index('idx_journal_voucher_company_date', ['companyId', 'voucherDate'])
@Index('idx_journal_voucher_entry_no', ['entryNo'])
export class JournalVoucherOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'voucher_type', type: 'varchar' }) voucherType!: string;
  @Column({ name: 'voucher_date', type: 'date' }) voucherDate!: string;
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

@Entity({ name: 'journal_line_draft' })
@Index('idx_journal_line_draft_voucher', ['journalVoucherId'])
export class JournalLineDraftOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'journal_voucher_id', type: 'uuid' }) journalVoucherId!: string;
  @Column({ name: 'line_no', type: 'int' }) lineNo!: number;
  @Column({ name: 'account_id', type: 'uuid' }) accountId!: string;
  @Column({ name: 'project_id', type: 'uuid', nullable: true }) projectId!: string | null;
  @Column({ name: 'cost_centre_id', type: 'uuid', nullable: true }) costCentreId!: string | null;
  @Column({ name: 'purpose_id', type: 'uuid', nullable: true }) purposeId!: string | null;
  @Column({ name: 'party_id', type: 'uuid', nullable: true }) partyId!: string | null;
  /** Persisted classification hints so a re-post/read need not re-query MAS (rehydration convenience). */
  @Column({ name: 'account_type', type: 'varchar', nullable: true }) accountType!: string | null;
  @Column({ name: 'is_control_account', type: 'boolean', default: false }) isControlAccount!: boolean;
  @Column({ name: 'debit', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  debit!: Decimal;
  @Column({ name: 'credit', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  credit!: Decimal;
  @Column({ name: 'narration', type: 'text', nullable: true }) narration!: string | null;
}
