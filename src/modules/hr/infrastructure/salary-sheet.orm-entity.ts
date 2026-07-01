/**
 * SalarySheetOrmEntity — the HR `salary_sheet` table (INFRASTRUCTURE). `status` is app-checked
 * DRAFT|POSTED ONLY — there is no stored 'REVERSED' value (design §3; salary-sheet.ts's header comment).
 * `salary_entry_id` FK → journal_entry, null while DRAFT, set at post. The draft-unique partial index
 * (`UNIQUE (company_id, financial_year_id, period_label) WHERE status='DRAFT'`) lives in the migration.
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

@Entity({ name: 'salary_sheet' })
@Index('idx_salary_sheet_company_fy_period', ['companyId', 'financialYearId', 'periodLabel'])
export class SalarySheetOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'period_label', type: 'varchar' }) periodLabel!: string;
  @Column({ name: 'period_start', type: 'date' }) periodStart!: string;
  @Column({ name: 'period_end', type: 'date' }) periodEnd!: string;
  @Column({ name: 'status', type: 'varchar', default: 'DRAFT' }) status!: string;
  @Column({ name: 'salary_entry_id', type: 'uuid', nullable: true }) salaryEntryId!: string | null;
  @Column({ name: 'posted_at', type: 'timestamptz', nullable: true }) postedAt!: Date | null;
  @Column({ name: 'posted_by', type: 'uuid', nullable: true }) postedBy!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
