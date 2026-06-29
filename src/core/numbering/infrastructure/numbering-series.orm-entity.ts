/**
 * NumberingSeriesOrmEntity — the per-(company, FY, voucher type) counter row (INFRASTRUCTURE only).
 * The unit of gaplessness (SRS §4/§8). Explicit snake_case columns (no naming strategy). NO
 * `deleted_at` — a series is operational state, never soft-deleted (FR-NUM-021). The unique constraint,
 * CHECKs and FKs live in the migration.
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

@Entity({ name: 'numbering_series' })
@Index('uq_numbering_series_triple', ['companyId', 'financialYearId', 'voucherType'], { unique: true })
export class NumberingSeriesOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'financial_year_id', type: 'uuid' })
  financialYearId!: string;

  @Column({ name: 'voucher_type', type: 'varchar' })
  voucherType!: string;

  @Column({ name: 'prefix', type: 'varchar' })
  prefix!: string;

  @Column({ name: 'padding_width', type: 'int', default: 4 })
  paddingWidth!: number;

  @Column({ name: 'last_sequence', type: 'int', default: 0 })
  lastSequence!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @VersionColumn({ name: 'version', type: 'int' })
  version!: number;
}
