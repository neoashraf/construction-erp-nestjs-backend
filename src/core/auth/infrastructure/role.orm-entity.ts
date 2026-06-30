import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';
import { RoleName } from '../domain/role';
import { decimalTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'role' })
@Index('idx_role_company_name', ['companyId', 'name'], { unique: true })
export class RoleOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: RoleName;
  @Column({ name: 'approval_limit', type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: decimalTransformer(4) })
  approvalLimit!: import('decimal.js').default | null;
  @Column({ name: 'is_unscoped', type: 'boolean', default: false }) isUnscoped!: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
