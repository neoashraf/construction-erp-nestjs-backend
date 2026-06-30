/** PartyOrmEntity — `party` row (INFRASTRUCTURE). Multi-role customer/supplier; opening_balance ref. */
import Decimal from 'decimal.js';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';
import { moneyTransformer } from '../../../../database/persistence/decimal.transformer';

@Entity({ name: 'party' })
@Index('idx_party_company', ['companyId'])
export class PartyOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'is_customer', type: 'boolean', default: false }) isCustomer!: boolean;
  @Column({ name: 'is_supplier', type: 'boolean', default: false }) isSupplier!: boolean;
  @Column({ name: 'tin', type: 'varchar', nullable: true }) tin!: string | null;
  @Column({ name: 'bin', type: 'varchar', nullable: true }) bin!: string | null;
  @Column({ name: 'address', type: 'text', nullable: true }) address!: string | null;
  @Column({ name: 'phone', type: 'varchar' }) phone!: string;
  @Column({ name: 'email', type: 'varchar', nullable: true }) email!: string | null;
  @Column({ name: 'payment_terms_days', type: 'int', default: 0 }) paymentTermsDays!: number;
  @Column({ name: 'opening_balance', type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: moneyTransformer })
  openingBalance!: Decimal | null;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
