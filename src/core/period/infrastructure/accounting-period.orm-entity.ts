/**
 * AccountingPeriodOrmEntity — TypeORM row for `accounting_period` (INFRASTRUCTURE). Explicit snake_case
 * columns; no `deleted_at` (periods are deactivated by close, never deleted). `@VersionColumn` guards
 * concurrent close/reopen. The UNIQUE + EXCLUDE-USING-gist non-overlap constraints + CHECK + FKs +
 * lookup index live in the migration.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity({ name: 'accounting_period' })
@Index('idx_accounting_period_lookup', ['companyId', 'financialYearId', 'startDate'])
export class AccountingPeriodOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'financial_year_id', type: 'uuid' })
  financialYearId!: string;

  @Column({ name: 'name', type: 'varchar' })
  name!: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

  @Column({ name: 'status', type: 'varchar' })
  status!: string;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'closed_by', type: 'uuid', nullable: true })
  closedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @VersionColumn({ name: 'version', type: 'int' })
  version!: number;
}
