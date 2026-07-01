/**
 * AttendanceRecordOrmEntity — the HR `attendance_record` table, one row per capture across all three modes
 * (INFRASTRUCTURE). money columns (overtime_hours, daily_rate) numeric(18,4) via moneyTransformer (exact).
 * The mode discriminator + per-mode CHECKs, the OFFICE partial-unique (one row per employee per day), the
 * is_confirmed↔accrual_entry_id guard, the accrual_entry_id FK → journal_entry (ON DELETE RESTRICT), and
 * the §7 indexes live in the migration.
 */
import Decimal from 'decimal.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'attendance_record' })
@Index('idx_attendance_company_date_mode', ['companyId', 'attendanceDate', 'mode'])
@Index('idx_attendance_project_cc_date', ['projectId', 'costCentreId', 'attendanceDate'])
@Index('idx_attendance_accrual_entry', ['accrualEntryId'])
export class AttendanceRecordOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'mode', type: 'varchar' }) mode!: string;
  @Column({ name: 'attendance_date', type: 'date' }) attendanceDate!: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId!: string;
  @Column({ name: 'cost_centre_id', type: 'uuid', nullable: true }) costCentreId!: string | null;
  @Column({ name: 'purpose_id', type: 'uuid', nullable: true }) purposeId!: string | null;
  @Column({ name: 'employee_id', type: 'uuid', nullable: true }) employeeId!: string | null;
  @Column({ name: 'check_in', type: 'time', nullable: true }) checkIn!: string | null;
  @Column({ name: 'check_out', type: 'time', nullable: true }) checkOut!: string | null;
  @Column({ name: 'day_status', type: 'varchar', nullable: true }) dayStatus!: string | null;
  @Column({
    name: 'overtime_hours',
    type: 'numeric',
    precision: 18,
    scale: 4,
    nullable: true,
    transformer: moneyTransformer,
  })
  overtimeHours!: Decimal | null;
  @Column({ name: 'party_id', type: 'uuid', nullable: true }) partyId!: string | null;
  @Column({ name: 'head_count', type: 'int', nullable: true }) headCount!: number | null;
  @Column({ name: 'labour_category', type: 'varchar', nullable: true }) labourCategory!: string | null;
  @Column({
    name: 'daily_rate',
    type: 'numeric',
    precision: 18,
    scale: 4,
    nullable: true,
    transformer: moneyTransformer,
  })
  dailyRate!: Decimal | null;
  @Column({ name: 'source', type: 'varchar', default: 'MANUAL' }) source!: string;
  @Column({ name: 'is_confirmed', type: 'boolean', default: false }) isConfirmed!: boolean;
  @Column({ name: 'accrual_entry_id', type: 'uuid', nullable: true }) accrualEntryId!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
