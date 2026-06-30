/** AccountGroupOrmEntity — `account_group` row (INFRASTRUCTURE). Typed, self-referencing hierarchy. */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'account_group' })
@Index('idx_account_group_company', ['companyId'])
export class AccountGroupOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'parent_group_id', type: 'uuid', nullable: true }) parentGroupId!: string | null;
  @Column({ name: 'type', type: 'varchar' }) type!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
