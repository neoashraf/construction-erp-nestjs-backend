/**
 * TypeOrmAttendanceRepository (INFRASTRUCTURE) — persists the AttendanceRecord aggregate. Enrols in the
 * active UnitOfWork via getManager; every method is companyId-scoped (F3). `insertMany` backs bulk capture
 * (FR-HR-007). `findByIdForUpdate` row-locks the daily-labour row at confirm (anti-double-confirm, edge
 * §12.7). `save` bumps `version` under the optimistic-lock check. `findOfficeRow` backs biometric/manual
 * reconciliation to one OFFICE row per employee per day (edge §12.9).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { AttendanceRecord } from '../domain/attendance-record';
import { AttendanceRepository, OfficeAttendanceSummary } from '../domain/ports/attendance.repository';
import { AttendanceRecordMapper } from './attendance-record.mapper';
import { AttendanceRecordOrmEntity } from './attendance-record.orm-entity';

@Injectable()
export class TypeOrmAttendanceRepository implements AttendanceRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(record: AttendanceRecord): Promise<void> {
    const row = AttendanceRecordMapper.toOrm(record);
    row.version = 1;
    await getManager(this.dataSource).getRepository(AttendanceRecordOrmEntity).insert(row);
  }

  async insertMany(records: AttendanceRecord[]): Promise<void> {
    if (records.length === 0) return;
    const rows = records.map((r) => {
      const row = AttendanceRecordMapper.toOrm(r);
      row.version = 1;
      return row;
    });
    await getManager(this.dataSource).getRepository(AttendanceRecordOrmEntity).insert(rows);
  }

  async save(record: AttendanceRecord, expectedVersion: number): Promise<void> {
    const row = AttendanceRecordMapper.toOrm(record);
    const res = await getManager(this.dataSource)
      .getRepository(AttendanceRecordOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        costCentreId: row.costCentreId,
        purposeId: row.purposeId,
        headCount: row.headCount,
        labourCategory: row.labourCategory,
        dailyRate: row.dailyRate,
        dayStatus: row.dayStatus,
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        overtimeHours: row.overtimeHours,
        isConfirmed: row.isConfirmed,
        accrualEntryId: row.accrualEntryId,
        version: expectedVersion + 1,
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: row.id,
        companyId: row.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`Attendance ${row.id} was modified concurrently`, { id: row.id });
    }
  }

  async findById(id: string, companyId: string): Promise<AttendanceRecord | null> {
    const row = await getManager(this.dataSource)
      .getRepository(AttendanceRecordOrmEntity)
      .findOne({ where: { id, companyId } as never });
    return row ? AttendanceRecordMapper.toDomain(row) : null;
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<AttendanceRecord | null> {
    const row = await getManager(this.dataSource)
      .getRepository(AttendanceRecordOrmEntity)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.id = :id AND a.company_id = :companyId', { id, companyId })
      .getOne();
    return row ? AttendanceRecordMapper.toDomain(row) : null;
  }

  async findOfficeRow(
    companyId: string,
    employeeId: string,
    attendanceDate: string,
  ): Promise<AttendanceRecord | null> {
    const row = await getManager(this.dataSource)
      .getRepository(AttendanceRecordOrmEntity)
      .findOne({ where: { companyId, employeeId, attendanceDate, mode: 'OFFICE' } as never });
    return row ? AttendanceRecordMapper.toDomain(row) : null;
  }

  async summarizeOffice(
    companyId: string,
    employeeId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<OfficeAttendanceSummary> {
    const rows: Array<{ day_status: string; overtime_hours: string | null; project_id: string }> =
      await getManager(this.dataSource).query(
        `SELECT day_status, overtime_hours::text AS overtime_hours, project_id
           FROM attendance_record
          WHERE company_id = $1 AND employee_id = $2 AND mode = 'OFFICE'
            AND attendance_date BETWEEN $3 AND $4`,
        [companyId, employeeId, periodStart, periodEnd],
      );

    let paidDays = 0;
    let attendedDays = 0;
    let overtimeHours = new Decimal(0);
    const projectCounts = new Map<string, number>();

    for (const r of rows) {
      if (r.day_status === 'PRESENT' || r.day_status === 'PAID_LEAVE') paidDays += 1;
      if (r.day_status === 'PRESENT') attendedDays += 1;
      if (r.overtime_hours) overtimeHours = overtimeHours.plus(r.overtime_hours);
      projectCounts.set(r.project_id, (projectCounts.get(r.project_id) ?? 0) + 1);
    }

    let primaryProjectId: string | null = null;
    let max = -1;
    for (const [pid, count] of projectCounts) {
      if (count > max) {
        max = count;
        primaryProjectId = pid;
      }
    }

    return {
      paidDays: String(paidDays),
      attendedDays: String(attendedDays),
      overtimeHours: overtimeHours.toFixed(4),
      primaryProjectId,
    };
  }
}
