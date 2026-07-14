import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ActionCode, ProjectScope } from '../domain/permission.entity';
import { decimalTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'permission' })
@Index('idx_permission_role_id', ['roleId'])
@Index('uq_permission_role_resource_action', ['roleId', 'resource', 'action'], { unique: true })
export class PermissionOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'role_id', type: 'uuid' }) roleId!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'resource', type: 'varchar' }) resource!: string;
  @Column({ name: 'action', type: 'varchar' }) action!: ActionCode;
  @Column({ name: 'project_scope', type: 'varchar', default: 'ASSIGNED' }) projectScope!: ProjectScope;
  @Column({ name: 'value_limit', type: 'numeric', precision: 18, scale: 4, nullable: true, transformer: decimalTransformer(4) })
  valueLimit!: import('decimal.js').default | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  // Plain column, NOT @VersionColumn (see role.orm-entity.ts): the domain owns the
  // version; @VersionColumn would ignore the passed value and auto-bump, desyncing it.
  @Column({ name: 'version', type: 'int', default: 1 }) version!: number;
}
