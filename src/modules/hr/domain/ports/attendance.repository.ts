/**
 * AttendanceRepository port (HR-owned, driven). PURE interface — the application depends on this; the
 * TypeORM adapter implements it. Persist/load the AttendanceRecord aggregate (bulk capture supported);
 * every method is companyId-scoped (F3). `findByIdForUpdate` row-locks the daily-labour row at confirm
 * (anti-double-confirm, edge §12.7). `findActiveEmployee` (office) supports biometric reconciliation to
 * one row per employee per day (edge §12.9). `findConfirmedForAccrual` loads a confirmed row to reverse.
 */
import { AttendanceRecord } from '../attendance-record';

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

export interface AttendanceRepository {
  insert(record: AttendanceRecord): Promise<void>;
  insertMany(records: AttendanceRecord[]): Promise<void>;
  save(record: AttendanceRecord, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<AttendanceRecord | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<AttendanceRecord | null>;
  /** The existing OFFICE row for an employee on a day (edge §12.9 reconciliation), or null. */
  findOfficeRow(companyId: string, employeeId: string, attendanceDate: string): Promise<AttendanceRecord | null>;
}

export const ATTENDANCE_REPOSITORY = Symbol('AttendanceRepository');
