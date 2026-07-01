/**
 * SalarySheetRepository port (HR-owned, driven). PURE interface — the application depends on this; the
 * TypeORM adapter implements it. Persist/load the SalarySheet aggregate + its lines; every method is
 * companyId-scoped (F3). `findByIdForUpdate` row-locks the sheet (anti-double-post, mirrors
 * AttendanceRepository/EmployeeRepository's own `findByIdForUpdate` convention). `existsDraftForPeriod`
 * backs the one-DRAFT-per-(financialYearId, periodLabel) guard (FR-HR-013; edge §12.4) — the DB partial
 * unique index (`WHERE status='DRAFT'`) is the backstop.
 */
import { SalarySheet } from '../salary-sheet';

export interface SalarySheetListFilter {
  financialYearId?: string;
  periodLabel?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface SalarySheetRepository {
  insert(sheet: SalarySheet): Promise<void>;
  save(sheet: SalarySheet, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<SalarySheet | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<SalarySheet | null>;
  existsDraftForPeriod(companyId: string, financialYearId: string, periodLabel: string): Promise<boolean>;
}

export const SALARY_SHEET_REPOSITORY = Symbol('SalarySheetRepository');
