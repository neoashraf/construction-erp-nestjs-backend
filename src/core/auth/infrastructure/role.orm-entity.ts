import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { decimalTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'role' })
@Index('idx_role_company_name', ['companyId', 'name'], { unique: true })
export class RoleOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'is_system', type: 'boolean', default: false }) isSystem!: boolean;
  @Column({ name: 'approval_limit', type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: decimalTransformer(4) })
  approvalLimit!: import('decimal.js').default | null;
  @Column({ name: 'is_unscoped', type: 'boolean', default: false }) isUnscoped!: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  // Plain column, NOT @VersionColumn: the domain owns the optimistic-lock version
  // (use-cases bump it explicitly and the repository writes p.version). A
  // @VersionColumn would auto-increment on every save and ignore the passed value,
  // desyncing the version the read-side returns from the one persisted — which
  // produced spurious OPTIMISTIC_LOCK_CONFLICT on the RBAC batch save.
  @Column({ name: 'version', type: 'int', default: 1 }) version!: number;
}
