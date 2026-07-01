/**
 * EmployeeRepository port (HR-owned, driven). PURE interface — the application depends on this; the
 * TypeORM adapter implements it. Persist/load the Employee aggregate + its append-only assignment history;
 * every method is companyId-scoped (F3). `existsCode` backs the company-unique employee_code guard
 * (FR-HR-001; the DB unique index is the backstop). `appendAssignment` inserts a history row and never
 * overwrites a prior one (FR-HR-002).
 */
import { Employee, EmployeeAssignment } from '../employee';

export interface EmployeeListFilter {
  status?: string;
  defaultProjectId?: string;
  wageType?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface EmployeeRepository {
  insert(employee: Employee): Promise<void>;
  save(employee: Employee, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<Employee | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<Employee | null>;
  existsCode(companyId: string, employeeCode: string): Promise<boolean>;
  findByCode(companyId: string, employeeCode: string): Promise<Employee | null>;
  appendAssignment(assignment: EmployeeAssignment): Promise<void>;
  listAssignments(employeeId: string, companyId: string): Promise<EmployeeAssignment[]>;
}

export const EMPLOYEE_REPOSITORY = Symbol('EmployeeRepository');
