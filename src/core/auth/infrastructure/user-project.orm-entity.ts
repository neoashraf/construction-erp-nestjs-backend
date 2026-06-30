import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'user_project' })
@Index('uq_user_project', ['userId', 'projectId'], { unique: true })
@Index('idx_user_project_user', ['userId'])
export class UserProjectOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @CreateDateColumn({ name: 'assigned_at', type: 'timestamptz' }) assignedAt!: Date;
}
