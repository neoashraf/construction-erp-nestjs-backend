/** AccountOrmEntity — `account` row (INFRASTRUCTURE). Typed, company-unique code, opening_balance ref. */
import Decimal from 'decimal.js';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';
import { moneyTransformer } from '../../../../database/persistence/decimal.transformer';

@Entity({ name: 'account' })
@Index('idx_account_company', ['companyId'])
export class AccountOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'code', type: 'varchar' }) code!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'account_group_id', type: 'uuid' }) accountGroupId!: string;
  @Column({ name: 'type', type: 'varchar' }) type!: string;
  @Column({ name: 'opening_balance', type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: moneyTransformer })
  openingBalance!: Decimal | null;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
