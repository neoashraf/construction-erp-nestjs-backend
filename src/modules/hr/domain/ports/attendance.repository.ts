/**
 * AttendanceRepository port (HR-owned, driven). PURE interface — the application depends on this; the
 * TypeORM adapter implements it. Persist/load the AttendanceRecord aggregate (bulk capture supported);
 * every method is companyId-scoped (F3). `findByIdForUpdate` row-locks the daily-labour row at confirm
 * (anti-double-confirm, edge §12.7). `findActiveEmployee` (office) supports biometric reconciliation to
 * one row per employee per day (edge §12.9). `findConfirmedForAccrual` loads a confirmed row to reverse.
 * `summarizeOffice` aggregates one employee's OFFICE rows over a period into the SalaryCalculator's
 * AttendanceSummary inputs (paidDays, attendedDays, overtimeAmount) for salary generation (design §5.2).
 */
import { AttendanceRecord } from '../attendance-record';
import { OfficeDayRow } from '../payroll-days';

export interface AttendanceListFilter {
  mode?: string;
  attendanceDate?: string;
  dateFrom?: string;
  dateTo?: string;
  projectId?: string;
  costCentreId?: string;
  employeeId?: string;
  partyId?: string;
  isConfirmed?: boolean;
  page?: number;
  pageSize?: number;
}

/** One employee's OFFICE attendance rolled up over a salary period, plus the project(s) worked (§16). */
export interface OfficeAttendanceSummary {
  paidDays: string; // PRESENT + PAID_LEAVE day count
  attendedDays: string; // PRESENT day count
  overtimeHours: string; // Σ overtime_hours
  /** The project worked most within the period (falls back to the employee's default project — SRS §16). */
  primaryProjectId: string | null;
}

export interface AttendanceRepository {
  insert(record: AttendanceRecord): Promise<void>;
  insertMany(records: AttendanceRecord[]): Promise<void>;
  save(record: AttendanceRecord, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<AttendanceRecord | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<AttendanceRecord | null>;
  /** The existing OFFICE row for an employee on a day (edge §12.9 reconciliation), or null. */
  findOfficeRow(companyId: string, employeeId: string, attendanceDate: string): Promise<AttendanceRecord | null>;
  /** The device-enrolment code for an employee — punches are keyed on the CODE, not the UUID. */
  findEmployeeCodeById(companyId: string, employeeId: string): Promise<string | null>;
  /** The OFFICE row id for each submitted (employee, date), in the order submitted. */
  findOfficeRowIds(
    companyId: string,
    rows: ReadonlyArray<{ employeeId: string; attendanceDate: string }>,
  ): Promise<string[]>;
  /**
   * Set the day-level fields that have no punch representation, creating the OFFICE row when the day
   * has no punches at all (a leave or absence day — and `paidDays` counts ROWS, so without this the
   * employee silently loses a day's pay).
   *
   * Times are NEVER written here: `reconcileDays` is the single writer of `check_in`/`check_out`, which
   * is what lets a device punch merge with a hand-keyed roster instead of overwriting it.
   */
  patchOfficeDayFields(
    companyId: string,
    financialYearId: string,
    employeeId: string,
    attendanceDate: string,
    projectId: string,
    fields: { dayStatus: string; overtimeHours: string },
  ): Promise<void>;
  /**
   * One employee's OFFICE days in the period, unaggregated (FR-HR-013a).
   *
   * `summarizeOffice` cannot serve the corrected payroll rule: that rule needs to know WHICH dates
   * carry a row, so a working day with no record can be told apart from a holiday and reported as a
   * data gap. A count cannot express that. `summarizeOffice` is KEPT for `primaryProjectId` and
   * `overtimeHours`, which are genuinely aggregates.
   */
  listOfficeDays(
    companyId: string,
    employeeId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<OfficeDayRow[]>;
  /** Roll up one employee's OFFICE attendance over [periodStart, periodEnd] for salary generation. */
  summarizeOffice(
    companyId: string,
    employeeId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<OfficeAttendanceSummary>;
}

export const ATTENDANCE_REPOSITORY = Symbol('AttendanceRepository');
