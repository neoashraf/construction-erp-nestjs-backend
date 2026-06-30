/** ItemUomConversionOrmEntity — `item_uom_conversion` row (INFRASTRUCTURE). Unique (item_id, uom). */
import Decimal from 'decimal.js';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';
import { moneyTransformer } from '../../../../database/persistence/decimal.transformer';

@Entity({ name: 'item_uom_conversion' })
@Index('idx_item_uom_item', ['itemId'])
export class ItemUomConversionOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'item_id', type: 'uuid' }) itemId!: string;
  @Column({ name: 'uom', type: 'varchar' }) uom!: string;
  @Column({ name: 'factor_to_base', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  factorToBase!: Decimal;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
