/**
 * RequisitionApprovalOrmEntity — the REQ `requisition_approval` table (INFRASTRUCTURE). An append-style
 * audit row written once at approve/reject (FR-REQ-008): decision, the tier that applied, the BDT
 * threshold the estimated value was compared against, the estimated value at review, the reason, and
 * who/when. decision/tier are app-checked varchar. threshold/estimate are numeric(18,4). FK ON DELETE
 * RESTRICT + the requisition_id index live in the migration.
 */
import Decimal from 'decimal.js';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'requisition_approval' })
@Index('idx_requisition_approval_requisition', ['requisitionId'])
export class RequisitionApprovalOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'requisition_id', type: 'uuid' }) requisitionId!: string;
  @Column({ name: 'decision', type: 'varchar' }) decision!: string;
  @Column({ name: 'tier', type: 'varchar' }) tier!: string;
  @Column({ name: 'threshold_evaluated', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  thresholdEvaluated!: Decimal;
  @Column({
    name: 'estimated_value_at_review',
    type: 'numeric',
    precision: 18,
    scale: 4,
    transformer: moneyTransformer,
  })
  estimatedValueAtReview!: Decimal;
  @Column({ name: 'reason', type: 'text', nullable: true }) reason!: string | null;
  @Column({ name: 'decided_by', type: 'uuid' }) decidedBy!: string;
  @Column({ name: 'decided_at', type: 'timestamptz' }) decidedAt!: Date;
}
