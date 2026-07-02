/**
 * ReportQueryService — inventory / requisition / HR reports (RPT #31 · FR-RPT-021…028) on fake read ports.
 * Proves the single-source-of-truth contract (FR-RPT-004): stock valuation returns the fake
 * InventoryReadPort figures VERBATIM and the salary register returns the fake HrReadPort figures VERBATIM —
 * RPT renders, never recomputes. Also proves: the low-stock threshold is a required param (MAS holds no
 * reorder attribute) and is forwarded to the port; the requisition variance is `requested − issued`;
 * attendance requires a month; and the effective project scope (F4) is handed to each port.
 */
import { ReportQueryService } from '../../../src/reports/application/report-query.service';
import { ReportScopeService } from '../../../src/reports/application/report-scope.service';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { InventoryReadPort, InventoryScope } from '../../../src/reports/domain/ports/inventory.read.port';
import {
  RequisitionReadPort,
  RequisitionScope,
  RequisitionIssueReadRow,
} from '../../../src/reports/domain/ports/requisition.read.port';
import {
  HrReadPort,
  AttendanceScope,
  EmployeePaymentScope,
  SalaryRegisterScope,
} from '../../../src/reports/domain/ports/hr.read.port';
import { PaginatedRows } from '../../../src/reports/domain/ports/ledger.read.port';
import {
  AttendanceSummaryRow,
  EmployeePaymentRow,
  SalaryRegisterRow,
  StockMovementSummaryRow,
  StockValuationRow,
} from '../../../src/reports/domain/report-result.model';

const CO = 'company-1';
const admin: Actor = {
  userId: 'u1', companyId: CO, financialYearId: 'fy1', role: 'ADMIN',
  isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pmAB: Actor = { ...admin, role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: ['A', 'B'] };

const STOCK_ROWS: StockValuationRow[] = [
  { godownId: 'g1', itemId: 'i1', quantityOnHand: '150.0000', totalValue: '75000.0000', weightedAverageRate: '500.0000', reorderLevel: null, asOfDate: null },
  { godownId: 'g1', itemId: 'i2', quantityOnHand: '5.0000', totalValue: '250.0000', weightedAverageRate: '50.0000', reorderLevel: null, asOfDate: null },
];

class FakeInventory implements InventoryReadPort {
  lastScope?: InventoryScope;
  stockValuation(scope: InventoryScope): Promise<{ rows: StockValuationRow[]; totalValue: string }> {
    this.lastScope = scope;
    return Promise.resolve({ rows: STOCK_ROWS, totalValue: '75250.0000' });
  }
  lowStock(scope: InventoryScope): Promise<StockValuationRow[]> {
    this.lastScope = scope;
    return Promise.resolve([{ ...STOCK_ROWS[1], reorderLevel: scope.reorderLevel ?? null }]);
  }
  movementSummary(scope: InventoryScope): Promise<PaginatedRows<StockMovementSummaryRow>> {
    this.lastScope = scope;
    return Promise.resolve({ items: [], total: 0 });
  }
}

class FakeRequisition implements RequisitionReadPort {
  lastScope?: RequisitionScope;
  requisitionVsIssue(scope: RequisitionScope): Promise<PaginatedRows<RequisitionIssueReadRow>> {
    this.lastScope = scope;
    return Promise.resolve({
      items: [
        { requisitionId: 'r1', projectId: 'A', costCentreId: 'cc1', itemId: 'i1', requestedQty: '100.0000', issuedQty: '60.0000' },
      ],
      total: 1,
    });
  }
}

const SALARY_ROWS: SalaryRegisterRow[] = [
  { employeeId: 'e1', projectId: 'A', costCentreId: 'cc1', gross: '60000.0000', allowances: '10000.0000', tds: '3000.0000', pf: '2400.0000', advanceRecovery: '5000.0000', other: '0.0000', net: '59600.0000' },
];
const SALARY_TOTALS = { gross: '60000.0000', allowances: '10000.0000', tds: '3000.0000', pf: '2400.0000', advanceRecovery: '5000.0000', other: '0.0000', net: '59600.0000' };

class FakeHr implements HrReadPort {
  lastSalaryScope?: SalaryRegisterScope;
  lastAttendanceScope?: AttendanceScope;
  lastPaymentScope?: EmployeePaymentScope;
  salaryRegister(scope: SalaryRegisterScope): Promise<{ rows: SalaryRegisterRow[]; totals: Record<string, string> }> {
    this.lastSalaryScope = scope;
    return Promise.resolve({ rows: SALARY_ROWS, totals: SALARY_TOTALS });
  }
  attendanceSummary(scope: AttendanceScope): Promise<PaginatedRows<AttendanceSummaryRow>> {
    this.lastAttendanceScope = scope;
    return Promise.resolve({
      items: [{ projectId: 'A', employeeId: 'e1', partyId: null, costCentreId: 'cc1', daysPresent: 20, paidLeave: 1, unpaidLeave: 0, absent: 1, headCountTotal: 22 }],
      total: 1,
    });
  }
  employeePayments(scope: EmployeePaymentScope): Promise<PaginatedRows<EmployeePaymentRow>> {
    this.lastPaymentScope = scope;
    return Promise.resolve({ items: [], total: 0 });
  }
}

describe('ReportQueryService — inventory / requisition / HR (RPT #31)', () => {
  const build = () => {
    const inv = new FakeInventory();
    const req = new FakeRequisition();
    const hr = new FakeHr();
    const svc = new ReportQueryService({} as never, inv, req, hr, new ReportScopeService());
    return { inv, req, hr, svc };
  };

  it('stock valuation: returns the InventoryReadPort rows + total VERBATIM (single source of truth)', async () => {
    const { svc } = build();
    const r = await svc.stockValuation({ financialYearId: 'fy1' }, admin);
    expect(r.reportName).toBe('stock-valuation');
    expect(r.rows).toBe(STOCK_ROWS); // same reference — no re-computation
    expect(r.totals).toEqual({ totalValue: '75250.0000' });
    expect(r.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('salary register: returns the HrReadPort rows + totals VERBATIM (single source of truth)', async () => {
    const { svc } = build();
    const r = await svc.salaryRegister({ salaryRunId: 'run-1' }, admin);
    expect(r.reportName).toBe('salary-register');
    expect(r.rows).toBe(SALARY_ROWS);
    expect(r.totals).toEqual(SALARY_TOTALS);
    expect(r.totals!.net).toBe('59600.0000');
  });

  it('low stock: requires a reorderLevel param (MAS holds no reorder attribute) → ValidationError', async () => {
    const { svc } = build();
    await expect(svc.lowStock({ financialYearId: 'fy1' }, admin)).rejects.toBeInstanceOf(ValidationError);
  });

  it('low stock: forwards the reorderLevel param to the port (param-driven threshold)', async () => {
    const { inv, svc } = build();
    const r = await svc.lowStock({ reorderLevel: '10' }, admin);
    expect(inv.lastScope?.reorderLevel).toBe('10');
    expect(r.rows[0].reorderLevel).toBe('10');
  });

  it('requisition vs issue: varianceQty = requestedQty − issuedQty (RPT derives the arithmetic)', async () => {
    const { svc } = build();
    const p = await svc.requisitionVsIssue({ financialYearId: 'fy1' }, admin);
    expect(p.items[0].requestedQty).toBe('100.0000');
    expect(p.items[0].issuedQty).toBe('60.0000');
    expect(p.items[0].varianceQty).toBe('40.0000');
  });

  it('salary register: requires salaryRunId OR (financialYearId + month)', async () => {
    const { svc } = build();
    await expect(svc.salaryRegister({}, admin)).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.salaryRegister({ financialYearId: 'fy1', month: '2026-06' }, admin)).resolves.toBeDefined();
  });

  it('attendance summary: requires a month (YYYY-MM)', async () => {
    const { svc } = build();
    await expect(svc.attendanceSummary({}, admin)).rejects.toBeInstanceOf(ValidationError);
    const p = await svc.attendanceSummary({ month: '2026-06' }, admin);
    expect(p.items).toHaveLength(1);
    expect(p.items[0].headCountTotal).toBe(22);
  });

  it('scope (F4): a PM is auto-filtered to assigned projects in the scope handed to each port', async () => {
    const { req, hr, svc } = build();
    await svc.requisitionVsIssue({ financialYearId: 'fy1' }, pmAB);
    expect(req.lastScope?.projectIds).toEqual(['A', 'B']);
    await svc.attendanceSummary({ month: '2026-06' }, pmAB);
    expect(hr.lastAttendanceScope?.projectIds).toEqual(['A', 'B']);
  });

  it('scope (F3): inventory valuation always carries the caller company id', async () => {
    const { inv, svc } = build();
    await svc.stockValuation({}, admin);
    expect(inv.lastScope?.companyId).toBe(CO);
  });
});
