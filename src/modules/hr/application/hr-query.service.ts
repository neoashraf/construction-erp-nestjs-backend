/**
 * HrQueryService — read side (skill §2.3): company-scoped Employee / Attendance / assignment / SalarySheet
 * DTOs straight from SQL for the list/read endpoints. No aggregates. Money serialises as numeric(18,4)
 * JSON strings; dates 'YYYY-MM-DD'; timestamps ISO-8601 UTC (overview §6). Bank account number/name and TIN
 * are write-only / MASKED on read (sensitive — NFR-002). Scoped (Site Engineer/PM) readers are filtered to
 * assigned projects (F4): excluded silently on list, 403 on a direct fetch of an unassigned project's row.
 *
 * `SalarySheet.status` in the DTO is the DERIVED status (design §3): the stored column is DRAFT|POSTED
 * only; a `salarySheetDto` looks up whether a `journal_entry` with `reversal_of = salary_entry_id` exists
 * and reports `REVERSED` when it does — the write-side aggregate never stores that literal (salary-sheet.ts
 * header comment). This is the ONE place the derived status is computed for API responses.
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
import { SalarySheetOrmEntity } from '../infrastructure/salary-sheet.orm-entity';
import { SalarySheetLineOrmEntity } from '../infrastructure/salary-sheet-line.orm-entity';
import { LabourPayableOrmEntity } from '../infrastructure/labour-payable.orm-entity';
import {
  PAYABLE_SETTLEMENT_PORT,
  PayableSettlementPort,
} from '../../payment/domain/ports/payable-settlement.port';
import { EmployeeListFilter } from '../domain/ports/employee.repository';
import { AttendanceListFilter } from '../domain/ports/attendance.repository';
import { SalarySheetListFilter } from '../domain/ports/salary-sheet.repository';

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

export interface SalarySheetLineDto {
  id: string;
  employeeId: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  paidDays: string;
  grossAmount: string;
  allowances: string;
  tds: string;
  pf: string;
  advanceRecovery: string;
  otherDeductions: string;
  netAmount: string;
}

export interface SalarySheetDto {
  id: string;
  financialYearId: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  status: 'DRAFT' | 'POSTED' | 'REVERSED';
  salaryEntryId: string | null;
  totalGross: string;
  totalDeductions: string;
  totalNet: string;
  version: number;
  lines?: SalarySheetLineDto[];
}

/** A payable's settlement summary, computed from PAY's applied projection (NOT a stored rollup). */
export interface PayableSettlementDto {
  accruedAmount: string;
  settledAmount: string;
  remainingOutstanding: string;
  status: 'OUTSTANDING' | 'PARTIALLY_SETTLED' | 'SETTLED';
}

@Injectable()
export class HrQueryService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(PAYABLE_SETTLEMENT_PORT) private readonly settlement: PayableSettlementPort,
  ) {}

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

  async listSalarySheets(filter: SalarySheetListFilter, actor: Actor): Promise<Paginated<SalarySheetDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(SalarySheetOrmEntity)
      .createQueryBuilder('s')
      .where('s.company_id = :companyId', { companyId: actor.companyId });
    if (filter.financialYearId) qb.andWhere('s.financial_year_id = :fy', { fy: filter.financialYearId });
    if (filter.periodLabel) qb.andWhere('s.period_label = :pl', { pl: filter.periodLabel });
    const [rows, total] = await qb
      .orderBy('s.period_label', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    const dtos = await Promise.all(rows.map((r) => this.salarySheetDto(r, false)));
    const filtered = filter.status ? dtos.filter((d) => d.status === filter.status) : dtos;
    return new Paginated(filtered, page, pageSize, total);
  }

  async getSalarySheet(id: string, includeLines: boolean, actor: Actor): Promise<SalarySheetDto | null> {
    const row = await getManager(this.dataSource)
      .getRepository(SalarySheetOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId } as never });
    if (!row) return null;
    return this.salarySheetDto(row, includeLines);
  }

  private async salarySheetDto(row: SalarySheetOrmEntity, includeLines: boolean): Promise<SalarySheetDto> {
    const manager = getManager(this.dataSource);
    const lineRows = await manager
      .getRepository(SalarySheetLineOrmEntity)
      .find({ where: { salarySheetId: row.id } as never, order: { createdAt: 'ASC' } });

    let status: SalarySheetDto['status'] = row.status as 'DRAFT' | 'POSTED';
    if (row.status === 'POSTED' && row.salaryEntryId) {
      // REVERSED is DERIVED (design §3): the stored column stays POSTED; report REVERSED only when a
      // journal_entry with reversal_of = salary_entry_id exists.
      const [reversal] = await manager.query(`SELECT id FROM journal_entry WHERE reversal_of = $1 LIMIT 1`, [
        row.salaryEntryId,
      ]);
      if (reversal) status = 'REVERSED';
    }

    let totalGross = new Decimal(0);
    let totalDeductions = new Decimal(0);
    let totalNet = new Decimal(0);
    for (const l of lineRows) {
      totalGross = totalGross.plus(l.grossAmount);
      totalDeductions = totalDeductions
        .plus(l.tds)
        .plus(l.pf)
        .plus(l.advanceRecovery)
        .plus(l.otherDeductions);
      totalNet = totalNet.plus(l.netAmount);
    }

    return {
      id: row.id,
      financialYearId: row.financialYearId,
      periodLabel: row.periodLabel,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      status,
      salaryEntryId: row.salaryEntryId,
      totalGross: totalGross.toFixed(4),
      totalDeductions: totalDeductions.toFixed(4),
      totalNet: totalNet.toFixed(4),
      version: row.version,
      lines: includeLines ? lineRows.map(salarySheetLineDto) : undefined,
    };
  }

  /**
   * A labour payable's settled/outstanding, read from PAY's applied projection through the exported
   * `PayableSettlementPort` (FR-HR-011: settled is a query over PAY's postings, never a re-post; HR stores a
   * `settled_amount` rollup but the authoritative figure is PAY's). Scoped readers must be assigned the
   * payable's project. Returns null when the payable is not in this company.
   */
  async labourPayableSettled(payableId: string, actor: Actor): Promise<PayableSettlementDto | null> {
    const row = await getManager(this.dataSource)
      .getRepository(LabourPayableOrmEntity)
      .findOne({ where: { id: payableId, companyId: actor.companyId } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    const accrued = new Decimal(row.accruedAmount);
    const settled = await this.settlement.appliedTo('LABOUR_PAYABLE', payableId, actor.companyId);
    return settlementDto(accrued, settled);
  }

  /**
   * A salary sheet's settled/outstanding (net of its lines vs PAY's applied payments). Salary has no project
   * dimension — visible to unscoped (Accounts/Admin) readers only. Returns null when not in this company.
   */
  async salarySheetSettled(sheetId: string, actor: Actor): Promise<PayableSettlementDto | null> {
    if (!actor.isUnscoped) throw new ForbiddenException('Salary payables are visible to Accounts/Admin only');
    const m = getManager(this.dataSource);
    const sheet = await m
      .getRepository(SalarySheetOrmEntity)
      .findOne({ where: { id: sheetId, companyId: actor.companyId } as never });
    if (!sheet) return null;
    const netRows: Array<{ net: string }> = await m.query(
      `SELECT COALESCE(SUM(net_amount), 0)::text AS net FROM salary_sheet_line WHERE salary_sheet_id = $1`,
      [sheetId],
    );
    const original = new Decimal(netRows[0]?.net ?? '0');
    const settled = await this.settlement.appliedTo('SALARY', sheetId, actor.companyId);
    return settlementDto(original, settled);
  }

  private assertProjectVisible(actor: Actor, projectId: string): void {
    if (!actor.isUnscoped && !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('Project not assigned to this user');
    }
  }
}

function settlementDto(original: Decimal, settled: Decimal): PayableSettlementDto {
  const remaining = original.minus(settled);
  const status: PayableSettlementDto['status'] = remaining.lessThanOrEqualTo(0)
    ? 'SETTLED'
    : settled.greaterThan(0)
      ? 'PARTIALLY_SETTLED'
      : 'OUTSTANDING';
  return {
    accruedAmount: original.toFixed(4),
    settledAmount: settled.toFixed(4),
    remainingOutstanding: remaining.toFixed(4),
    status,
  };
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

function salarySheetLineDto(r: SalarySheetLineOrmEntity): SalarySheetLineDto {
  return {
    id: r.id,
    employeeId: r.employeeId,
    projectId: r.projectId,
    costCentreId: r.costCentreId,
    purposeId: r.purposeId,
    paidDays: new Decimal(r.paidDays).toFixed(4),
    grossAmount: new Decimal(r.grossAmount).toFixed(4),
    allowances: new Decimal(r.allowances).toFixed(4),
    tds: new Decimal(r.tds).toFixed(4),
    pf: new Decimal(r.pf).toFixed(4),
    advanceRecovery: new Decimal(r.advanceRecovery).toFixed(4),
    otherDeductions: new Decimal(r.otherDeductions).toFixed(4),
    netAmount: new Decimal(r.netAmount).toFixed(4),
  };
}
