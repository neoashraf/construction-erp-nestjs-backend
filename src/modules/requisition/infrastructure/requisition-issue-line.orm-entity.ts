/**
 * RequisitionIssueLineOrmEntity — the REQ `requisition_issue_line` table (INFRASTRUCTURE, brief #23). One
 * row per item issued within an issue event: the requisition line it fulfils, the INV `stock_movement_id`
 * it traces to, and the exact issued qty/rate/value (`value = qty × rate` CHECK in the migration —
 * mirrors `stock_journal_line`'s style). Append-only — never edited after insert (mirrors the line's
 * parent issue). numeric(18,4) via moneyTransformer.
 */
import Decimal from 'decimal.js';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'requisition_issue_line' })
@Index('idx_requisition_issue_line_issue', ['requisitionIssueId'])
@Index('idx_requisition_issue_line_stock_movement', ['stockMovementId'])
export class RequisitionIssueLineOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'requisition_issue_id', type: 'uuid' }) requisitionIssueId!: string;
  @Column({ name: 'requisition_line_id', type: 'uuid' }) requisitionLineId!: string;
  @Column({ name: 'item_id', type: 'uuid' }) itemId!: string;
  @Column({ name: 'godown_id', type: 'uuid' }) godownId!: string;
  @Column({ name: 'stock_movement_id', type: 'uuid' }) stockMovementId!: string;
  @Column({ name: 'issued_quantity', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  issuedQuantity!: Decimal;
  @Column({ name: 'rate', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  rate!: Decimal;
  @Column({ name: 'value', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  value!: Decimal;
}
