/**
 * ContraVoucherOrmEntity + ContraLineOrmEntity — the GEN `contra_voucher` / `contra_line` DRAFT tables
 * (INFRASTRUCTURE). GEN owns only the draft; the posted ledger entry is LED's (linked by
 * journal_entry_id). Money is numeric(18,4) via moneyTransformer (string ↔ Decimal, exact — never
 * float). CHECKs, FKs (ON DELETE RESTRICT), and indexes live in the migration.
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

@Entity({ name: 'contra_voucher' })
@Index('idx_contra_voucher_company_status', ['companyId', 'status'])
@Index('idx_contra_voucher_company_date', ['companyId', 'voucherDate'])
@Index('idx_contra_voucher_entry_no', ['entryNo'])
export class ContraVoucherOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
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

@Entity({ name: 'contra_line' })
@Index('idx_contra_line_voucher', ['contraVoucherId'])
export class ContraLineOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'contra_voucher_id', type: 'uuid' }) contraVoucherId!: string;
  @Column({ name: 'line_no', type: 'int' }) lineNo!: number;
  @Column({ name: 'account_id', type: 'uuid' }) accountId!: string;
  @Column({ name: 'debit', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  debit!: Decimal;
  @Column({ name: 'credit', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  credit!: Decimal;
  @Column({ name: 'narration', type: 'text', nullable: true }) narration!: string | null;
}
