/**
 * JournalEntryOrmEntity — header row for `journal_entry` (INFRASTRUCTURE). Append-only: NO status /
 * is_reversed / deleted_at / version column (FR-LED-026, AC14) — "reversed?" is derived from
 * `reversal_of`. Explicit snake_case columns. The append-only trigger + FKs + indexes live in the
 * migration; the ORM never UPDATEs these rows.
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'journal_entry' })
@Index('idx_journal_entry_company_fy', ['companyId', 'financialYearId'])
@Index('idx_journal_entry_company_fy_date', ['companyId', 'financialYearId', 'voucherDate'])
@Index('idx_journal_entry_reversal_of', ['reversalOf'])
@Index('idx_journal_entry_source', ['sourceType', 'sourceId'])
export class JournalEntryOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'financial_year_id', type: 'uuid' })
  financialYearId!: string;

  @Column({ name: 'entry_no', type: 'varchar' })
  entryNo!: string;

  @Column({ name: 'voucher_type', type: 'varchar' })
  voucherType!: string;

  @Column({ name: 'voucher_date', type: 'date' })
  voucherDate!: string;

  @Column({ name: 'source_type', type: 'varchar' })
  sourceType!: string;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId!: string;

  @Column({ name: 'is_reversal', type: 'boolean', default: false })
  isReversal!: boolean;

  @Column({ name: 'reversal_of', type: 'uuid', nullable: true })
  reversalOf!: string | null;

  @Column({ name: 'posted_at', type: 'timestamptz' })
  postedAt!: Date;

  @Column({ name: 'posted_by', type: 'uuid' })
  postedBy!: string;

  @Column({ name: 'narration', type: 'text', nullable: true })
  narration!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
