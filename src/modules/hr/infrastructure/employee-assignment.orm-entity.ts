/**
 * EmployeeAssignmentOrmEntity — the HR `employee_assignment` append-only history table (INFRASTRUCTURE).
 * A reassignment INSERTs a new row; the app never UPDATEs/DELETEs a prior one (FR-HR-002). No version /
 * soft-delete — the row is immutable history. FK employee_id ON DELETE RESTRICT (migration).
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'employee_assignment' })
@Index('idx_employee_assignment_employee_date', ['employeeId', 'effectiveDate'])
export class EmployeeAssignmentOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'employee_id', type: 'uuid' }) employeeId!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'effective_date', type: 'date' }) effectiveDate!: string;
  @Column({ name: 'note', type: 'text', nullable: true }) note!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
}
