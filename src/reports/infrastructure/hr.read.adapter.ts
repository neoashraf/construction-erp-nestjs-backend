/**
 * HrReadAdapter (RPT · FR-RPT-026/-027/-028) — INFRASTRUCTURE `HrReadPort`. Reads HR's OWN salary/attendance
 * projections and PAY's settlement surface via `@Inject(DATA_SOURCE)` + `getManager`:
 *   - salary register  → `salary_sheet` (POSTED) ⋈ `salary_sheet_line` (HR FR-HR-015); totals reconcile to
 *     the posted SALARY ledger entry (`salary_sheet.salary_entry_id`);
 *   - attendance summary → `attendance_record` day-status roll-up per project/employee/party/cost-centre;
 *   - employee payments → `payment_allocation` ⋈ `payment_voucher` (POSTED, non-reversed via the
 *     `journal_entry.reversal_of` NOT EXISTS guard) for payable types SALARY / LABOUR_PAYABLE.
 * RPT renders HR's/PAY's figures — it NEVER recomputes salary math (FR-RPT-004). Read-only; company on every
 * query (F3); assigned-projects filter applied where the row carries a project (F4).
 *
 * NOTE (FR-RPT-028): PAY's `payment_allocation` for SALARY references the salary-sheet RUN and for
 * LABOUR_PAYABLE references a head-count payable — neither carries an `employee_id`, so per-employee
 * attribution is not derivable at the allocation granularity in the Phase-1 schema. Each row therefore
 * carries the settled `payableRef` (traceable to its payable) with `employeeId = null`; an `employee_id`
 * on the payable/allocation surface is an HR/PAY follow-up (RPT owns no schema).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../database/database.module';
import { getManager } from '../../infrastructure/unit-of-work/transaction-context';
import { resolvePaging } from '../../infrastructure/http/pagination';
import {
  AttendanceSummaryRow,
  EmployeePaymentRow,
  SalaryRegisterRow,
} from '../domain/report-result.model';
import {
  AttendanceScope,
  EmployeePaymentScope,
  HrReadPort,
  SalaryRegisterScope,
} from '../domain/ports/hr.read.port';
import { PaginatedRows } from '../domain/ports/ledger.read.port';

const ZERO_TOTALS = (): Record<string, string> => ({
  gross: '0.0000',
  allowances: '0.0000',
  tds: '0.0000',
  pf: '0.0000',
  advanceRecovery: '0.0000',
  other: '0.0000',
  net: '0.0000',
});

@Injectable()
export class HrReadAdapter implements HrReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  // ── salary register (FR-RPT-027) ─────────────────────────────────────────────────────────────────
  async salaryRegister(
    scope: SalaryRegisterScope,
  ): Promise<{ rows: SalaryRegisterRow[]; totals: Record<string, string> }> {
    const m = this.manager();
    const sheetId = await this.resolveSalaryRun(scope);
    if (!sheetId) return { rows: [], totals: ZERO_TOTALS() };

    const params: unknown[] = [sheetId];
    const conds = ['sl.salary_sheet_id = $1'];
    // Project-wise filter: explicit projectId then the F4 assigned-projects set.
    if (scope.projectId) {
      params.push(scope.projectId);
      conds.push(`sl.project_id = $${params.length}`);
    } else if (scope.projectIds !== null) {
      if (scope.projectIds.length === 0) {
        conds.push('false');
      } else {
        params.push(scope.projectIds);
        conds.push(`sl.project_id = ANY($${params.length}::uuid[])`);
      }
    }
    const where = conds.join(' AND ');

    const rows = await m.query(
      `SELECT sl.employee_id, sl.project_id, sl.cost_centre_id,
              sl.gross_amount::text     AS gross,
              sl.allowances::text       AS allowances,
              sl.tds::text              AS tds,
              sl.pf::text               AS pf,
              sl.advance_recovery::text AS advance_recovery,
              sl.other_deductions::text AS other,
              sl.net_amount::text       AS net
         FROM salary_sheet_line sl
        WHERE ${where}
        ORDER BY sl.project_id, sl.employee_id`,
      params,
    );

    const totals = ZERO_TOTALS();
    const mapped: SalaryRegisterRow[] = rows.map((r: Record<string, string>) => {
      const row: SalaryRegisterRow = {
        employeeId: r.employee_id,
        projectId: r.project_id ?? null,
        costCentreId: r.cost_centre_id ?? null,
        gross: new Decimal(r.gross).toFixed(4),
        allowances: new Decimal(r.allowances).toFixed(4),
        tds: new Decimal(r.tds).toFixed(4),
        pf: new Decimal(r.pf).toFixed(4),
        advanceRecovery: new Decimal(r.advance_recovery).toFixed(4),
        other: new Decimal(r.other).toFixed(4),
        net: new Decimal(r.net).toFixed(4),
      };
      totals.gross = new Decimal(totals.gross).plus(row.gross).toFixed(4);
      totals.allowances = new Decimal(totals.allowances).plus(row.allowances).toFixed(4);
      totals.tds = new Decimal(totals.tds).plus(row.tds).toFixed(4);
      totals.pf = new Decimal(totals.pf).plus(row.pf).toFixed(4);
      totals.advanceRecovery = new Decimal(totals.advanceRecovery).plus(row.advanceRecovery).toFixed(4);
      totals.other = new Decimal(totals.other).plus(row.other).toFixed(4);
      totals.net = new Decimal(totals.net).plus(row.net).toFixed(4);
      return row;
    });
    return { rows: mapped, totals };
  }

  /** Resolve the posted salary run: an explicit id, else (financialYearId + month) → the sheet by period. */
  private async resolveSalaryRun(scope: SalaryRegisterScope): Promise<string | null> {
    const m = this.manager();
    if (scope.salaryRunId) {
      const [row] = await m.query(
        `SELECT id FROM salary_sheet WHERE id = $1 AND company_id = $2 AND status = 'POSTED'`,
        [scope.salaryRunId, scope.companyId],
      );
      return row?.id ?? null;
    }
    if (scope.financialYearId && scope.month) {
      const [row] = await m.query(
        `SELECT id FROM salary_sheet
          WHERE company_id = $1 AND financial_year_id = $2 AND status = 'POSTED'
            AND to_char(period_start,'YYYY-MM') = $3
          ORDER BY period_start DESC LIMIT 1`,
        [scope.companyId, scope.financialYearId, scope.month],
      );
      return row?.id ?? null;
    }
    return null;
  }

  // ── attendance summary (FR-RPT-026) ──────────────────────────────────────────────────────────────
  async attendanceSummary(scope: AttendanceScope): Promise<PaginatedRows<AttendanceSummaryRow>> {
    const m = this.manager();
    const params: unknown[] = [scope.companyId, scope.month];
    const conds = ['ar.company_id = $1', "to_char(ar.attendance_date,'YYYY-MM') = $2"];
    const push = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.employeeId) push('ar.employee_id = $$', scope.employeeId);
    if (scope.costCentreId) push('ar.cost_centre_id = $$', scope.costCentreId);
    if (scope.projectIds === null) {
      // all projects
    } else if (scope.projectIds.length === 0) {
      conds.push('false');
    } else {
      params.push(scope.projectIds);
      conds.push(`ar.project_id = ANY($${params.length}::uuid[])`);
    }
    const where = conds.join(' AND ');
    const groupExpr = 'ar.project_id, ar.employee_id, ar.party_id, ar.cost_centre_id';

    const [{ count }] = await m.query(
      `SELECT count(*)::text AS count FROM (
         SELECT 1 FROM attendance_record ar WHERE ${where} GROUP BY ${groupExpr}
       ) g`,
      params,
    );
    const total = parseInt(count, 10);

    const { skip, take } = resolvePaging(scope);
    const rows = await m.query(
      `SELECT ar.project_id, ar.employee_id, ar.party_id, ar.cost_centre_id,
              COUNT(*) FILTER (WHERE ar.day_status = 'PRESENT')::int      AS days_present,
              COUNT(*) FILTER (WHERE ar.day_status = 'PAID_LEAVE')::int   AS paid_leave,
              COUNT(*) FILTER (WHERE ar.day_status = 'UNPAID_LEAVE')::int AS unpaid_leave,
              COUNT(*) FILTER (WHERE ar.day_status = 'ABSENT')::int       AS absent,
              COALESCE(SUM(COALESCE(ar.head_count, 1)), 0)::int           AS head_count_total
         FROM attendance_record ar
        WHERE ${where}
        GROUP BY ${groupExpr}
        ORDER BY ar.project_id, ar.employee_id NULLS LAST, ar.party_id NULLS LAST, ar.cost_centre_id NULLS LAST
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return {
      items: rows.map((r: Record<string, string | number | null>) => ({
        projectId: (r.project_id as string) ?? null,
        employeeId: (r.employee_id as string) ?? null,
        partyId: (r.party_id as string) ?? null,
        costCentreId: (r.cost_centre_id as string) ?? null,
        daysPresent: Number(r.days_present),
        paidLeave: Number(r.paid_leave),
        unpaidLeave: Number(r.unpaid_leave),
        absent: Number(r.absent),
        headCountTotal: Number(r.head_count_total),
      })),
      total,
    };
  }

  // ── employee payment history (FR-RPT-028) ────────────────────────────────────────────────────────
  async employeePayments(scope: EmployeePaymentScope): Promise<PaginatedRows<EmployeePaymentRow>> {
    const m = this.manager();
    const params: unknown[] = [scope.companyId];
    const conds = [
      'pv.company_id = $1',
      "pv.status = 'POSTED'",
      'NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reversal_of = pv.journal_entry_id)',
      "pa.payable_type IN ('SALARY','LABOUR_PAYABLE')",
    ];
    const push = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.financialYearId) push('pv.financial_year_id = $$', scope.financialYearId);
    if (scope.dateFrom) push('pv.payment_date >= $$', scope.dateFrom);
    if (scope.dateTo) push('pv.payment_date <= $$', scope.dateTo);
    // F4 project filter on the allocation (labour payable carries a project; SALARY may be null → excluded
    // when scoped, mirroring the ledger's project clause).
    if (scope.projectIds === null || scope.projectIds === undefined) {
      // all projects
    } else if (scope.projectIds.length === 0) {
      conds.push('false');
    } else {
      params.push(scope.projectIds);
      conds.push(`pa.project_id = ANY($${params.length}::uuid[])`);
    }
    const where = conds.join(' AND ');
    const from = 'FROM payment_allocation pa JOIN payment_voucher pv ON pv.id = pa.payment_voucher_id';

    const [{ count }] = await m.query(`SELECT count(*)::text AS count ${from} WHERE ${where}`, params);
    const total = parseInt(count, 10);

    const { skip, take } = resolvePaging(scope);
    const rows = await m.query(
      `SELECT to_char(pv.payment_date,'YYYY-MM-DD') AS payment_date,
              pa.amount_allocated::text AS paid_amount,
              pa.payable_type, pa.payable_id
         ${from} WHERE ${where}
        ORDER BY pv.payment_date ASC, pv.entry_no ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return {
      items: rows.map((r: Record<string, string>) => ({
        employeeId: null,
        paymentDate: r.payment_date,
        paidAmount: new Decimal(r.paid_amount).toFixed(4),
        payableType: r.payable_type,
        payableRef: r.payable_id,
      })),
      total,
    };
  }
}
