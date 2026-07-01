/**
 * HrAccountConfigOrmEntity — the HR `hr_account_config` table (INFRASTRUCTURE). The company-scoped
 * role→account (or role→cost-centre) mapping `HrAccountResolverAdapter.salaryAccounts()` reads to resolve
 * the six SALARY posting accounts + the Labour cost centre WITHOUT hard-coding well-known CoA codes
 * (design §2.4/§8; brief's own Outputs). One row per role: `GROSS_SALARY` / `EMPLOYER_PF` /
 * `SALARY_PAYABLE` / `TDS_PAYABLE` / `PF_PAYABLE` / `STAFF_ADVANCE_RECOVERY` set `account_id`;
 * `LABOUR_COST_CENTRE` sets `cost_centre_id`. Exactly one of the two columns is non-null per row (a CHECK
 * in the migration). NOT seeded by this brief's migration — seeded at go-live (deployment concern); tests
 * insert their own rows for the test company.
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const HR_ACCOUNT_CONFIG_ROLES = [
  'GROSS_SALARY',
  'EMPLOYER_PF',
  'SALARY_PAYABLE',
  'TDS_PAYABLE',
  'PF_PAYABLE',
  'STAFF_ADVANCE_RECOVERY',
  'LABOUR_COST_CENTRE',
] as const;
export type HrAccountConfigRole = (typeof HR_ACCOUNT_CONFIG_ROLES)[number];

@Entity({ name: 'hr_account_config' })
@Index('idx_hr_account_config_company_role', ['companyId', 'role'], { unique: true })
export class HrAccountConfigOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'role', type: 'varchar' }) role!: string;
  @Column({ name: 'account_id', type: 'uuid', nullable: true }) accountId!: string | null;
  @Column({ name: 'cost_centre_id', type: 'uuid', nullable: true }) costCentreId!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
