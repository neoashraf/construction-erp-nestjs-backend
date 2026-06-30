import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { AuditAction } from '../domain/audit-log.entity';

@Entity({ name: 'audit_log' })
@Index('idx_audit_log_company_entity', ['companyId', 'entityType', 'entityId'])
@Index('idx_audit_log_user', ['userId'])
@Index('idx_audit_log_created_at', ['createdAt'])
@Index('idx_audit_log_company_created', ['companyId', 'createdAt'])
export class AuditLogOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'action', type: 'varchar' }) action!: AuditAction;
  @Column({ name: 'entity_type', type: 'varchar' }) entityType!: string;
  @Column({ name: 'entity_id', type: 'varchar' }) entityId!: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  @Column({ name: 'before', type: 'jsonb', nullable: true }) before!: Record<string, unknown> | null;
  @Column({ name: 'after', type: 'jsonb', nullable: true }) after!: Record<string, unknown> | null;
  @Column({ name: 'ip_address', type: 'varchar', nullable: true }) ipAddress!: string | null;
  @Column({ name: 'seal', type: 'varchar' }) seal!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
