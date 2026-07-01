/**
 * EmployeeOrmEntity — the HR `employee` master table (INFRASTRUCTURE). Office staff only. wage_amount is
 * numeric(18,4) via moneyTransformer (exact — never float); bank/TIN columns are sensitive (masked on
 * read — NFR-002). The (company_id, employee_code) unique index, the wage_amount>=0 CHECK, the status
 * CHECK, and the FKs (ON DELETE RESTRICT) live in the migration.
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

@Entity({ name: 'employee' })
@Index('idx_employee_company_status', ['companyId', 'status'])
@Index('idx_employee_company_project', ['companyId', 'defaultProjectId'])
export class EmployeeOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'employee_code', type: 'varchar' }) employeeCode!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'designation', type: 'varchar' }) designation!: string;
  @Column({ name: 'default_project_id', type: 'uuid', nullable: true }) defaultProjectId!: string | null;
  @Column({ name: 'department', type: 'varchar', nullable: true }) department!: string | null;
  @Column({ name: 'work_base', type: 'varchar' }) workBase!: string;
  @Column({ name: 'wage_type', type: 'varchar' }) wageType!: string;
  @Column({ name: 'wage_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  wageAmount!: Decimal;
  @Column({ name: 'bank_account_name', type: 'varchar', nullable: true }) bankAccountName!: string | null;
  @Column({ name: 'bank_account_no', type: 'varchar', nullable: true }) bankAccountNo!: string | null;
  @Column({ name: 'bank_name', type: 'varchar', nullable: true }) bankName!: string | null;
  @Column({ name: 'pf_applicable', type: 'boolean', default: false }) pfApplicable!: boolean;
  @Column({ name: 'gratuity_applicable', type: 'boolean', default: false }) gratuityApplicable!: boolean;
  @Column({ name: 'wppf_applicable', type: 'boolean', default: false }) wppfApplicable!: boolean;
  @Column({ name: 'tin', type: 'varchar', nullable: true }) tin!: string | null;
  @Column({ name: 'joining_date', type: 'date' }) joiningDate!: string;
  @Column({ name: 'status', type: 'varchar', default: 'ACTIVE' }) status!: string;
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
