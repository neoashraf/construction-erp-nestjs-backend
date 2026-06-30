/** CostCentreOrmEntity — `cost_centre` row (INFRASTRUCTURE). Company-global; company-unique code. */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'cost_centre' })
@Index('idx_cost_centre_company', ['companyId'])
export class CostCentreOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'code', type: 'varchar' }) code!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
