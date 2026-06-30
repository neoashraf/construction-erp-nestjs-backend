/** ProjectOrmEntity — `project` row (INFRASTRUCTURE). Explicit snake_case; @VersionColumn for concurrency. */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

@Entity({ name: 'project' })
@Index('idx_project_company', ['companyId'])
@Index('idx_project_company_status', ['companyId', 'status'])
export class ProjectOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'project_code', type: 'varchar' }) projectCode!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'location', type: 'text', nullable: true }) location!: string | null;
  @Column({ name: 'customer_id', type: 'uuid' }) customerId!: string;
  @Column({ name: 'project_manager_id', type: 'uuid' }) projectManagerId!: string;
  @Column({ name: 'start_date', type: 'date' }) startDate!: string;
  @Column({ name: 'expected_end_date', type: 'date' }) expectedEndDate!: string;
  @Column({ name: 'actual_end_date', type: 'date', nullable: true }) actualEndDate!: string | null;
  @Column({ name: 'status', type: 'varchar', default: 'PLANNED' }) status!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
