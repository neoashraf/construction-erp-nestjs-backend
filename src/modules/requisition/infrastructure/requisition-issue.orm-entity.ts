/**
 * RequisitionIssueOrmEntity — the REQ `requisition_issue` table (INFRASTRUCTURE, brief #23). One row per
 * issue event: the LED consumption entry it produced (`journal_entry_id`), the issued value, who/when, and
 * append-only reversal tracking (`reversed_at`/`reversed_by_id`, never edited in place — a reversal SETS
 * these once via `markReversed`, the original row's other columns are never touched again). numeric(18,4)
 * via moneyTransformer. FKs (ON DELETE RESTRICT) + the `journal_entry_id` index live in the migration.
 */
import Decimal from 'decimal.js';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'requisition_issue' })
@Index('idx_requisition_issue_requisition', ['requisitionId'])
@Index('idx_requisition_issue_journal_entry', ['journalEntryId'])
export class RequisitionIssueOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'requisition_id', type: 'uuid' }) requisitionId!: string;
  @Column({ name: 'issue_no', type: 'int' }) issueNo!: number;
  @Column({ name: 'from_godown_id', type: 'uuid' }) fromGodownId!: string;
  @Column({ name: 'journal_entry_id', type: 'uuid' }) journalEntryId!: string;
  @Column({ name: 'entry_no', type: 'varchar', nullable: true }) entryNo!: string | null;
  @Column({ name: 'issued_value', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  issuedValue!: Decimal;
  @Column({ name: 'issued_by_id', type: 'uuid' }) issuedById!: string;
  @CreateDateColumn({ name: 'issued_at', type: 'timestamptz' }) issuedAt!: Date;
  @Column({ name: 'negative_stock_authorised_by_id', type: 'uuid', nullable: true })
  negativeStockAuthorisedById!: string | null;
  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true }) reversedAt!: Date | null;
  @Column({ name: 'reversed_by_id', type: 'uuid', nullable: true }) reversedById!: string | null;
}
