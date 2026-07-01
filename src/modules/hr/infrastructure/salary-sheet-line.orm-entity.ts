/**
 * SalarySheetLineOrmEntity — the HR `salary_sheet_line` table (INFRASTRUCTURE), one row per employee per
 * sheet — also the data behind the printable payslip (FR-HR-017). Money columns numeric(18,4) via
 * moneyTransformer (exact). FKs (salary_sheet_id/employee/project/cost_centre/purpose, ALL ON DELETE
 * RESTRICT per the skill's universal FK convention — mirrors journal_line → journal_entry) live in the
 * migration.
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

@Entity({ name: 'salary_sheet_line' })
@Index('idx_salary_sheet_line_sheet', ['salarySheetId'])
export class SalarySheetLineOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'salary_sheet_id', type: 'uuid' }) salarySheetId!: string;
  @Column({ name: 'employee_id', type: 'uuid' }) employeeId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid' }) costCentreId!: string;
  @Column({ name: 'purpose_id', type: 'uuid' }) purposeId!: string;
  @Column({ name: 'paid_days', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  paidDays!: Decimal;
  @Column({ name: 'gross_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  grossAmount!: Decimal;
  @Column({ name: 'allowances', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  allowances!: Decimal;
  @Column({ name: 'tds', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  tds!: Decimal;
  @Column({ name: 'pf', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  pf!: Decimal;
  @Column({ name: 'advance_recovery', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  advanceRecovery!: Decimal;
  @Column({ name: 'other_deductions', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  otherDeductions!: Decimal;
  @Column({ name: 'net_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  netAmount!: Decimal;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
