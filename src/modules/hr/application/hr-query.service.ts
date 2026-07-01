/**
 * HrQueryService — read side (skill §2.3): company-scoped Employee / Attendance / assignment DTOs straight
 * from SQL for the list/read endpoints. No aggregates. Money serialises as numeric(18,4) JSON strings;
 * dates 'YYYY-MM-DD'; timestamps ISO-8601 UTC (overview §6). Bank account number/name and TIN are
 * write-only / MASKED on read (sensitive — NFR-002). Scoped (Site Engineer/PM) readers are filtered to
 * assigned projects (F4): excluded silently on list, 403 on a direct fetch of an unassigned project's row.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { EmployeeOrmEntity } from '../infrastructure/employee.orm-entity';
import { AttendanceRecordOrmEntity } from '../infrastructure/attendance-record.orm-entity';
import { EmployeeAssignmentOrmEntity } from '../infrastructure/employee-assignment.orm-entity';
import { EmployeeListFilter } from '../domain/ports/employee.repository';
import { AttendanceListFilter } from '../domain/ports/attendance.repository';

export interface EmployeeDto {
  id: string;
  employeeCode: string;
  name: string;
  designation: string;
  defaultProjectId: string | null;
  department: string | null;
  workBase: string;
  wageType: string;
  wageAmount: string;
  bankName: string | null;
  bankAccountNoMasked: string | null;
  pfApplicable: boolean;
  gratuityApplicable: boolean;
  wppfApplicable: boolean;
  tinMasked: string | null;
  joiningDate: string;
  status: string;
  version: number;
}

export interface AssignmentDto {
  id: string;
  employeeId: string;
  projectId: string;
  effectiveDate: string;
  note: string | null;
}

export interface AttendanceDto {
  id: string;
  mode: string;
  attendanceDate: string;
  projectId: string;
  costCentreId: string | null;
  purposeId: string | null;
  employeeId: string | null;
  checkIn: string | null;
  checkOut: string | null;
  dayStatus: string | null;
  overtimeHours: string | null;
  partyId: string | null;
  headCount: number | null;
  labourCategory: string | null;
  dailyRate: string | null;
  source: string;
  isConfirmed: boolean;
  accrualEntryId: string | null;
}

@Injectable()
export class HrQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async listEmployees(filter: EmployeeListFilter, actor: Actor): Promise<Paginated<EmployeeDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(EmployeeOrmEntity)
      .createQueryBuilder('e')
      .where('e.company_id = :companyId AND e.deleted_at IS NULL', { companyId: actor.companyId });
    if (filter.status) qb.andWhere('e.status = :status', { status: filter.status });
    if (filter.defaultProjectId) {
      qb.andWhere('e.default_project_id = :pid', { pid: filter.defaultProjectId });
    }
    if (filter.wageType) qb.andWhere('e.wage_type = :wt', { wt: filter.wageType });
    if (filter.q) {
      qb.andWhere('(e.employee_code ILIKE :q OR e.name ILIKE :q)', { q: `%${filter.q}%` });
    }
    const [rows, total] = await qb
      .orderBy('e.employee_code', 'ASC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map(employeeDto), page, pageSize, total);
  }

  async getEmployee(id: string, actor: Actor): Promise<EmployeeDto | null> {
    const row = await getManager(this.dataSource)
      .getRepository(EmployeeOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    return row ? employeeDto(row) : null;
  }

  async listAssignments(employeeId: string, actor: Actor): Promise<AssignmentDto[]> {
    const rows = await getManager(this.dataSource)
      .getRepository(EmployeeAssignmentOrmEntity)
      .find({
        where: { employeeId, companyId: actor.companyId } as never,
        order: { effectiveDate: 'DESC', createdAt: 'DESC' },
      });
    return rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      projectId: r.projectId,
      effectiveDate: r.effectiveDate,
      note: r.note,
    }));
  }

  async listAttendance(
    filter: AttendanceListFilter,
    actor: Actor,
  ): Promise<Paginated<AttendanceDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(AttendanceRecordOrmEntity)
      .createQueryBuilder('a')
      .where('a.company_id = :companyId', { companyId: actor.companyId });
    if (filter.mode) qb.andWhere('a.mode = :mode', { mode: filter.mode });
    if (filter.attendanceDate) qb.andWhere('a.attendance_date = :d', { d: filter.attendanceDate });
    if (filter.dateFrom) qb.andWhere('a.attendance_date >= :df', { df: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('a.attendance_date <= :dt', { dt: filter.dateTo });
    if (filter.projectId) {
      this.assertProjectVisible(actor, filter.projectId);
      qb.andWhere('a.project_id = :pid', { pid: filter.projectId });
    }
    if (filter.costCentreId) qb.andWhere('a.cost_centre_id = :cc', { cc: filter.costCentreId });
    if (filter.employeeId) qb.andWhere('a.employee_id = :eid', { eid: filter.employeeId });
    if (filter.partyId) qb.andWhere('a.party_id = :party', { party: filter.partyId });
    if (filter.isConfirmed !== undefined) {
      qb.andWhere('a.is_confirmed = :ic', { ic: filter.isConfirmed });
    }
    // Scoped readers (Site Engineer/PM) see only assigned projects (F4).
    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) return new Paginated([], page, pageSize, 0);
      qb.andWhere('a.project_id IN (:...assigned)', { assigned: actor.assignedProjectIds });
    }
    const [rows, total] = await qb
      .orderBy('a.attendance_date', 'DESC')
      .addOrderBy('a.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map(attendanceDto), page, pageSize, total);
  }

  async getAttendance(id: string, actor: Actor): Promise<AttendanceDto | null> {
    const row = await getManager(this.dataSource)
      .getRepository(AttendanceRecordOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    return attendanceDto(row);
  }

  private assertProjectVisible(actor: Actor, projectId: string): void {
    if (!actor.isUnscoped && !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('Project not assigned to this user');
    }
  }
}

function mask(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return '****';
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

function employeeDto(r: EmployeeOrmEntity): EmployeeDto {
  return {
    id: r.id,
    employeeCode: r.employeeCode,
    name: r.name,
    designation: r.designation,
    defaultProjectId: r.defaultProjectId,
    department: r.department,
    workBase: r.workBase,
    wageType: r.wageType,
    wageAmount: new Decimal(r.wageAmount).toFixed(4),
    bankName: r.bankName,
    bankAccountNoMasked: mask(r.bankAccountNo),
    pfApplicable: r.pfApplicable,
    gratuityApplicable: r.gratuityApplicable,
    wppfApplicable: r.wppfApplicable,
    tinMasked: mask(r.tin),
    joiningDate: r.joiningDate,
    status: r.status,
    version: r.version,
  };
}

function attendanceDto(r: AttendanceRecordOrmEntity): AttendanceDto {
  return {
    id: r.id,
    mode: r.mode,
    attendanceDate: r.attendanceDate,
    projectId: r.projectId,
    costCentreId: r.costCentreId,
    purposeId: r.purposeId,
    employeeId: r.employeeId,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    dayStatus: r.dayStatus,
    overtimeHours: r.overtimeHours != null ? new Decimal(r.overtimeHours).toFixed(4) : null,
    partyId: r.partyId,
    headCount: r.headCount,
    labourCategory: r.labourCategory,
    dailyRate: r.dailyRate != null ? new Decimal(r.dailyRate).toFixed(4) : null,
    source: r.source,
    isConfirmed: r.isConfirmed,
    accrualEntryId: r.accrualEntryId,
  };
}
