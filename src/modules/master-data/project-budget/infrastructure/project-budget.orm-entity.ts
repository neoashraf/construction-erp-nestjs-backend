/** ProjectBudgetOrmEntity — `project_budget` row (INFRASTRUCTURE). Unique (project_id, cost_centre_id). */
import Decimal from 'decimal.js';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';
import { moneyTransformer } from '../../../../database/persistence/decimal.transformer';

@Entity({ name: 'project_budget' })
@Index('idx_project_budget_project', ['projectId'])
export class ProjectBudgetOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'budgeted_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  budgetedAmount!: Decimal;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
