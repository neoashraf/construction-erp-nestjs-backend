/** RefreshTokenOrmEntity — `refresh_token` table (INFRASTRUCTURE). Server-side JTI allowlist. */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'refresh_token' })
@Index('idx_refresh_token_user', ['userId'])
@Index('idx_refresh_token_jti', ['jti'], { unique: true })
export class RefreshTokenOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'jti', type: 'varchar' }) jti!: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true }) revokedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
