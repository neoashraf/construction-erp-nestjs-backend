/**
 * LabourPayableOrmEntity — the HR `labour_payable` table (INFRASTRUCTURE). The accrued liability written
 * alongside the daily-labour accrual; settled_amount/status rolled up from PAY events (no re-post —
 * FR-HR-011). Money columns numeric(18,4) via moneyTransformer. accrual_entry_id FK → journal_entry
 * (ON DELETE RESTRICT); status CHECK; indexes in the migration.
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

@Entity({ name: 'labour_payable' })
@Index('idx_labour_payable_company_project', ['companyId', 'projectId'])
@Index('idx_labour_payable_accrual_entry', ['accrualEntryId'])
export class LabourPayableOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'accrual_date', type: 'date' }) accrualDate!: string;
  @Column({ name: 'accrued_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  accruedAmount!: Decimal;
  @Column({ name: 'accrual_entry_id', type: 'uuid' }) accrualEntryId!: string;
  @Column({ name: 'settled_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  settledAmount!: Decimal;
  @Column({ name: 'status', type: 'varchar', default: 'OUTSTANDING' }) status!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
