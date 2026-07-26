/**
 * ORM entities for the three attendance-report configuration tables (INFRASTRUCTURE). Discovered by the
 * `*.orm-entity.{ts,js}` convention in `data-source.ts`; the constraints/indexes live in the migration
 * `1784700000000-CreateAttendanceReportConfig`. These are plain config rows — no version column, no soft
 * delete, no ledger involvement.
 */
import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** The late cut-off, one row per company. Absent row ⇒ the reports fall back to 09:30. */
@Entity({ name: 'attendance_setting' })
export class AttendanceSettingOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'late_after_hour', type: 'int', default: 9 }) lateAfterHour!: number;
  @Column({ name: 'late_after_minute', type: 'int', default: 30 }) lateAfterMinute!: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

/** A recurring weekend day: 0 = Sunday … 6 = Saturday. */
@Entity({ name: 'weekly_holiday' })
export class WeeklyHolidayOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'weekday', type: 'int' }) weekday!: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

/** A dated public holiday. Overrides a weekly holiday on the same date so the real name shows (§3.3). */
@Entity({ name: 'government_holiday' })
export class GovernmentHolidayOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'date', type: 'date' }) date!: string;
  @Column({ name: 'name', type: 'varchar' }) name!: string;
  @Column({ name: 'local_name', type: 'varchar', nullable: true }) localName!: string | null;
  @Column({ name: 'source', type: 'varchar', default: 'import' }) source!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
