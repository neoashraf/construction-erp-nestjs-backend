/** UserOrmEntity — `user` table (INFRASTRUCTURE). password_hash never serialized. */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'user' })
@Index('idx_user_company_email', ['companyId', 'email'], { unique: true })
@Index('idx_user_company', ['companyId'])
export class UserOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'email', type: 'varchar' }) email!: string;
  @Column({ name: 'password_hash', type: 'varchar' }) passwordHash!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'role', type: 'varchar' }) role!: string;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
  @Column({ name: 'must_change_password', type: 'boolean', default: true }) mustChangePassword!: boolean;
  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true }) lastLoginAt!: Date | null;
  @Column({ name: 'phone', type: 'varchar', nullable: true }) phone!: string | null;
  @Column({ name: 'avatar_url', type: 'varchar', nullable: true }) avatarUrl!: string | null;
  @Column({ name: 'avatar_public_id', type: 'varchar', nullable: true }) avatarPublicId!: string | null;
  @Column({ name: 'failed_login_attempts', type: 'int', default: 0 }) failedLoginAttempts!: number;
  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true }) lockedUntil!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
