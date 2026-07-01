/**
 * PayslipService — payslip data for a POSTED salary run (design §2.2, FR-HR-017; API contract
 * `GET /api/salary/sheets/:id/payslips`). Payslips exist only once a sheet is posted (AC10) — a DRAFT
 * sheet throws SalaryNotPostedError (`SALARY_NOT_POSTED`). Reads the sheet + its lines through the
 * SalarySheetRepository (the posted SalarySheetLine data IS the payslip — SRS §8 note) and joins employee
 * identity via EmployeeRepository. Amounts are `Decimal(18,4)` strings (৳); Bangla employee names are
 * never truncated (NFR-008).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { Actor } from '../../../core/tenancy/tenant-context';
import { SalaryNotPostedError } from '../domain/errors';
import { SALARY_SHEET_REPOSITORY, SalarySheetRepository } from '../domain/ports/salary-sheet.repository';
import { EMPLOYEE_REPOSITORY, EmployeeRepository } from '../domain/ports/employee.repository';

export interface Payslip {
  employeeId: string;
  employeeCode: string;
  name: string;
  designation: string;
  periodLabel: string;
  paidDays: string;
  grossAmount: string;
  allowances: string;
  deductions: {
    tds: string;
    pf: string;
    advanceRecovery: string;
    other: string;
  };
  netAmount: string;
}

@Injectable()
export class PayslipService {
  constructor(
    @Inject(SALARY_SHEET_REPOSITORY) private readonly repo: SalarySheetRepository,
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepository,
  ) {}

  /** Payslip data for a posted run; `employeeId` narrows to one employee, omitted returns all. */
  async forSheet(sheetId: string, employeeId: string | undefined, actor: Actor): Promise<Payslip[]> {
    const sheet = await this.repo.findById(sheetId, actor.companyId);
    if (!sheet) throw new NotFoundError(`Salary sheet ${sheetId} not found`);
    if (sheet.props.status !== 'POSTED') throw new SalaryNotPostedError(sheetId);

    const lines = employeeId
      ? sheet.lines.filter((l) => l.props.employeeId === employeeId)
      : sheet.lines;

    const payslips: Payslip[] = [];
    for (const line of lines) {
      const p = line.props;
      const emp = await this.employees.findById(p.employeeId, actor.companyId);
      payslips.push({
        employeeId: p.employeeId,
        employeeCode: emp?.props.employeeCode ?? '',
        name: emp?.props.name ?? '',
        designation: emp?.props.designation ?? '',
        periodLabel: sheet.props.periodLabel,
        paidDays: p.paidDays.toFixed(),
        grossAmount: p.grossAmount.toFixed(),
        allowances: p.allowances.toFixed(),
        deductions: {
          tds: p.tds.toFixed(),
          pf: p.pf.toFixed(),
          advanceRecovery: p.advanceRecovery.toFixed(),
          other: p.otherDeductions.toFixed(),
        },
        netAmount: p.netAmount.toFixed(),
      });
    }
    return payslips;
  }
}
