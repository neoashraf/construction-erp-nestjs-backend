/**
 * AttendanceRecordMapper (INFRASTRUCTURE) — AttendanceRecord aggregate ↔ `attendance_record` ORM row.
 * The domain never imports TypeORM; this is the only seam. Money ↔ Decimal exact via the transformer.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../common/money';
import {
  AttendanceMode,
  AttendanceRecord,
  AttendanceSource,
  DayStatus,
} from '../domain/attendance-record';
import { AttendanceRecordOrmEntity } from './attendance-record.orm-entity';

export const AttendanceRecordMapper = {
  toOrm(rec: AttendanceRecord): AttendanceRecordOrmEntity {
    const p = rec.props;
    const row = new AttendanceRecordOrmEntity();
    row.id = rec.id;
    row.companyId = p.companyId;
    row.financialYearId = p.financialYearId;
    row.mode = p.mode;
    row.attendanceDate = p.attendanceDate;
    row.projectId = p.projectId;
    row.costCentreId = p.costCentreId;
    row.purposeId = p.purposeId;
    row.employeeId = p.employeeId;
    row.checkIn = p.checkIn;
    row.checkOut = p.checkOut;
    row.dayStatus = p.dayStatus;
    row.overtimeHours = p.overtimeHours ? p.overtimeHours.amount : null;
    row.partyId = p.partyId;
    row.headCount = p.headCount;
    row.labourCategory = p.labourCategory;
    row.dailyRate = p.dailyRate ? p.dailyRate.amount : null;
    row.source = p.source;
    row.isConfirmed = p.isConfirmed;
    row.accrualEntryId = p.accrualEntryId;
    return row;
  },

  toDomain(r: AttendanceRecordOrmEntity): AttendanceRecord {
    return AttendanceRecord.rehydrate(r.id, {
      companyId: r.companyId,
      financialYearId: r.financialYearId,
      mode: r.mode as AttendanceMode,
      attendanceDate: r.attendanceDate,
      projectId: r.projectId,
      costCentreId: r.costCentreId,
      purposeId: r.purposeId,
      employeeId: r.employeeId,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      dayStatus: r.dayStatus as DayStatus | null,
      overtimeHours: r.overtimeHours != null ? Money.of(new Decimal(r.overtimeHours)) : null,
      partyId: r.partyId,
      headCount: r.headCount,
      labourCategory: r.labourCategory,
      dailyRate: r.dailyRate != null ? Money.of(new Decimal(r.dailyRate)) : null,
      source: r.source as AttendanceSource,
      isConfirmed: r.isConfirmed,
      accrualEntryId: r.accrualEntryId,
      version: r.version,
    });
  },
};
