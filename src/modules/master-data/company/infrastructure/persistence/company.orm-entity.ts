/**
 * CompanyOrmEntity — TypeORM persistence row for `company` (INFRASTRUCTURE only). Column names are
 * explicit snake_case (the datasource sets no naming strategy). `@VersionColumn` backs optimistic
 * concurrency (FR-MAS-032). Company is the tenant root: it has no `company_id` of its own.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity({ name: 'company' })
export class CompanyOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'name', type: 'varchar' })
  name!: string;

  @Column({ name: 'legal_name', type: 'varchar' })
  legalName!: string;

  @Column({ name: 'bin', type: 'varchar' })
  bin!: string;

  @Column({ name: 'tin', type: 'varchar' })
  tin!: string;

  @Column({ name: 'address', type: 'text', nullable: true })
  address!: string | null;

  @Column({ name: 'currency', type: 'varchar', default: 'BDT' })
  currency!: string;

  @Column({ name: 'date_format', type: 'varchar', default: 'DD/MM/YYYY' })
  dateFormat!: string;

  @Column({ name: 'locale', type: 'varchar', default: 'bn-BD' })
  locale!: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @VersionColumn({ name: 'version', type: 'int' })
  version!: number;
}
