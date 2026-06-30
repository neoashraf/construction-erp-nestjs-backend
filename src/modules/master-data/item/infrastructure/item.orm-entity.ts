/** ItemOrmEntity — `item` row (INFRASTRUCTURE). Company-unique code; default_account_id posting default. */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'item' })
@Index('idx_item_company', ['companyId'])
export class ItemOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'code', type: 'varchar' }) code!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'base_uom', type: 'varchar' }) baseUom!: string;
  @Column({ name: 'hs_code', type: 'varchar', nullable: true }) hsCode!: string | null;
  @Column({ name: 'default_account_id', type: 'uuid' }) defaultAccountId!: string;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
