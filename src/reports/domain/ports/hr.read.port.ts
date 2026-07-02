/**
 * HrReadPort (RPT · FR-RPT-026/-027/-028) — PURE domain port. The seam to HR's salary/attendance read
 * surfaces (and PAY's settlement surface for payment history). The adapter runs scoped SELECTs over
 * `salary_sheet` ⋈ `salary_sheet_line` (salary register), `attendance_record` (attendance roll-up), and
 * `payment_allocation` ⋈ `payment_voucher` (employee payment history). RPT renders HR's/PAY's figures and
 * NEVER recomputes salary math (FR-RPT-004). Company is always on the query (F3); the assigned-projects
 * filter is applied where the row carries a project (F4) — but the HR:READ gate is the primary control.
 */
import { PaginatedRows } from './ledger.read.port';
import {
  AttendanceSummaryRow,
  EmployeePaymentRow,
  SalaryRegisterRow,
} from '../report-result.model';

export const HR_READ_PORT = Symbol('HR_READ_PORT');

export interface SalaryRegisterScope {
  companyId: string;
  projectIds: string[] | null;
  /** A posted salary run id, OR (financialYearId + month) to resolve the run. */
  salaryRunId?: string;
  financialYearId?: string;
  /** 'YYYY-MM'. */
  month?: string;
  projectId?: string;
  page?: number;
  pageSize?: number;
}

export interface AttendanceScope {
  companyId: string;
  projectIds: string[] | null;
  /** 'YYYY-MM' — the month rolled up. */
  month: string;
  employeeId?: string;
  costCentreId?: string;
  page?: number;
  pageSize?: number;
}

export interface EmployeePaymentScope {
  companyId: string;
  projectIds: string[] | null;
  employeeId?: string;
  financialYearId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface HrReadPort {
  /** Salary register for a posted run — per employee, project-wise; totals reconcile to the SALARY entry. */
  salaryRegister(
    scope: SalaryRegisterScope,
  ): Promise<{ rows: SalaryRegisterRow[]; totals: Record<string, string> }>;
  /** Monthly attendance roll-up per project/employee/subcontractor/cost-centre (FR-RPT-026). */
  attendanceSummary(scope: AttendanceScope): Promise<PaginatedRows<AttendanceSummaryRow>>;
  /** Employee salary/labour-payable settlements over a date range (PAY, posted non-reversed) (FR-RPT-028). */
  employeePayments(scope: EmployeePaymentScope): Promise<PaginatedRows<EmployeePaymentRow>>;
}
