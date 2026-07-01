/**
 * StockJournalOrmEntity + StockJournalLineOrmEntity — the `stock_journal` header / `stock_journal_line`
 * OUT-IN-side rows (INFRASTRUCTURE). Mirrors `journal-voucher.orm-entity.ts`'s conventions: money/qty
 * numeric(18,4) via moneyTransformer/qtyTransformer, `@VersionColumn`, checked-varchar status/mode live
 * in the migration. `journal_entry_id` nullable FK to LED `journal_entry` (null for a value-neutral
 * same-account transfer, design §4.2).
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
import { moneyTransformer, qtyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'stock_journal' })
@Index('idx_stock_journal_company_status_date', ['companyId', 'status', 'voucherDate'])
@Index('idx_stock_journal_company_from_godown', ['companyId', 'fromGodownId'])
@Index('idx_stock_journal_company_to_godown', ['companyId', 'toGodownId'])
@Index('idx_stock_journal_item', ['itemId'])
export class StockJournalOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'entry_no', type: 'varchar', nullable: true }) entryNo!: string | null;
  @Column({ name: 'voucher_date', type: 'date' }) voucherDate!: string;
  @Column({ name: 'mode', type: 'varchar' }) mode!: string;
  @Column({ name: 'status', type: 'varchar' }) status!: string;
  @Column({ name: 'from_godown_id', type: 'uuid', nullable: true }) fromGodownId!: string | null;
  @Column({ name: 'to_godown_id', type: 'uuid', nullable: true }) toGodownId!: string | null;
  @Column({ name: 'item_id', type: 'uuid' }) itemId!: string;

  @Column({ name: 'quantity', type: 'numeric', precision: 18, scale: 4, transformer: qtyTransformer })
  quantity!: Decimal;
  @Column({ name: 'rate', type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: moneyTransformer })
  rate!: Decimal | null;
  @Column({ name: 'value', type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: moneyTransformer })
  value!: Decimal | null;

  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'purpose_id', type: 'uuid' }) purposeId!: string;

  @Column({ name: 'issued_by_id', type: 'uuid', nullable: true }) issuedById!: string | null;
  @Column({ name: 'received_by_id', type: 'uuid', nullable: true }) receivedById!: string | null;
  @Column({ name: 'approved_by_id', type: 'uuid', nullable: true }) approvedById!: string | null;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true }) approvedAt!: Date | null;

  @Column({ name: 'allow_negative_stock', type: 'boolean', default: false }) allowNegativeStock!: boolean;
  @Column({ name: 'negative_stock_authorised_by_id', type: 'uuid', nullable: true })
  negativeStockAuthorisedById!: string | null;
  @Column({ name: 'negative_stock_reason', type: 'text', nullable: true }) negativeStockReason!: string | null;

  @Column({ name: 'journal_entry_id', type: 'uuid', nullable: true }) journalEntryId!: string | null;
  @Column({ name: 'narration', type: 'text', nullable: true }) narration!: string | null;
  @Column({ name: 'posted_at', type: 'timestamptz', nullable: true }) postedAt!: Date | null;
  @Column({ name: 'posted_by_id', type: 'uuid', nullable: true }) postedById!: string | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}

@Entity({ name: 'stock_journal_line' })
@Index('idx_stock_journal_line_journal', ['stockJournalId'])
export class StockJournalLineOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'stock_journal_id', type: 'uuid' }) stockJournalId!: string;
  @Column({ name: 'line_no', type: 'int' }) lineNo!: number;
  @Column({ name: 'side', type: 'varchar' }) side!: string;
  @Column({ name: 'godown_id', type: 'uuid' }) godownId!: string;
  @Column({ name: 'item_id', type: 'uuid' }) itemId!: string;

  @Column({ name: 'quantity', type: 'numeric', precision: 18, scale: 4, transformer: qtyTransformer })
  quantity!: Decimal;
  @Column({ name: 'rate', type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: moneyTransformer })
  rate!: Decimal | null;
  @Column({ name: 'value', type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: moneyTransformer })
  value!: Decimal | null;

  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'purpose_id', type: 'uuid' }) purposeId!: string;
}
