/**
 * ReportQueryService — project reports (RPT #32 · FR-RPT-004/-015/-016/-017/-025) on fake read ports.
 * Proves the single-source-of-truth contract (FR-RPT-004):
 *   - ipc-billing returns the fake SalesReadPort figures VERBATIM and ONLY adds the ageing bucket (FR-RPT-017);
 *   - cost-centre-variance returns the fake CostControlReadPort figures VERBATIM, incl. an UNBUDGETED pair
 *     (null budget/variance/utilisation) — RPT performs no second computation (FR-RPT-025);
 *   - project-pnl profit = revenue − cost from the fake LedgerReadPort, with a per-cost-centre breakdown +
 *     a project total row (FR-RPT-015);
 *   - the effective project scope (F4) is handed to the sales/cost-control ports; an unassigned projectId is 403.
 */
import { ForbiddenException } from '@nestjs/common';
import { ReportQueryService } from '../../../src/reports/application/report-query.service';
import { ReportScopeService } from '../../../src/reports/application/report-scope.service';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { LedgerReadPort, LedgerScope, PaginatedRows } from '../../../src/reports/domain/ports/ledger.read.port';
import {
  IpcBillingReadRow,
  IpcBillingTotals,
  SalesReadPort,
  SalesScope,
} from '../../../src/reports/domain/ports/sales.read.port';
import { CostControlReadPort, CostControlScope } from '../../../src/reports/domain/ports/cost-control.read.port';
import {
  AccountLedgerRow,
  BalanceSheetRow,
  CostCentreVarianceRow,
  LabourCostRow,
  ProjectPnlRow,
  TrialBalanceRow,
} from '../../../src/reports/domain/report-result.model';

const CO = 'company-1';
const admin: Actor = {
  userId: 'u1', companyId: CO, financialYearId: 'fy1', role: 'ADMIN',
  isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pmAB: Actor = { ...admin, role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: ['A', 'B'] };
const pmB: Actor = { ...admin, role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: ['B'] };

// ── fake LED: P&L grouped by cost centre + totals; labour cost stub ──
const PNL_ROWS: ProjectPnlRow[] = [
  { projectId: null, costCentreId: 'cc1', revenue: '3000.0000', cost: '2000.0000', profit: '1000.0000' },
  { projectId: null, costCentreId: 'cc2', revenue: '1000.0000', cost: '1200.0000', profit: '-200.0000' },
];
const PNL_TOTALS = { revenue: '4000.0000', cost: '3200.0000', profit: '800.0000' };

class FakeLedger implements LedgerReadPort {
  lastScope?: LedgerScope;
  profitAndLoss(scope: LedgerScope): Promise<{ rows: ProjectPnlRow[]; totals: { revenue: string; cost: string; profit: string } }> {
    this.lastScope = scope;
    return Promise.resolve({ rows: PNL_ROWS.map((r) => ({ ...r })), totals: { ...PNL_TOTALS } });
  }
  labourCost(scope: LedgerScope): Promise<{ rows: LabourCostRow[]; totals: { labourCost: string } }> {
    this.lastScope = scope;
    return Promise.resolve({
      rows: [{ projectId: 'A', costCentreId: 'cc1', labourCost: '1200.0000' }],
      totals: { labourCost: '1200.0000' },
    });
  }
  trialBalance(): Promise<{ rows: TrialBalanceRow[]; totals: { debit: string; credit: string } }> {
    return Promise.resolve({ rows: [], totals: { debit: '0.0000', credit: '0.0000' } });
  }
  accountLedger(): Promise<PaginatedRows<AccountLedgerRow>> { return Promise.resolve({ items: [], total: 0 }); }
  daybook(): Promise<PaginatedRows<AccountLedgerRow>> { return Promise.resolve({ items: [], total: 0 }); }
  cashBankBook(): Promise<PaginatedRows<AccountLedgerRow>> { return Promise.resolve({ items: [], total: 0 }); }
  balanceSheet(): Promise<{ rows: BalanceSheetRow[]; totals: { assets: string; liabilities: string; equity: string } }> {
    return Promise.resolve({ rows: [], totals: { assets: '0.0000', liabilities: '0.0000', equity: '0.0000' } });
  }
}

// ── fake SAL: per-IPC figures (SAL's definitions) — RPT must render verbatim + add ageing only ──
const IPC_ROWS: IpcBillingReadRow[] = [
  {
    ipcId: 'ipc-1', projectId: 'A', ipcNo: 'IPC-2026-000007', ipcDate: '2026-05-31', dueDate: '2100-01-01',
    certifiedAmount: '1375000.0000', billedAmount: '1457500.0000', receivedAmount: '1000000.0000',
    outstandingAmount: '375000.0000', retentionHeld: '137500.0000',
  },
  {
    ipcId: 'ipc-2', projectId: 'A', ipcNo: 'IPC-2026-000008', ipcDate: '2026-04-30', dueDate: '2000-01-01',
    certifiedAmount: '500000.0000', billedAmount: '520000.0000', receivedAmount: '0.0000',
    outstandingAmount: '450000.0000', retentionHeld: '50000.0000',
  },
];
const IPC_TOTALS: IpcBillingTotals = {
  certified: '1875000.0000', billed: '1977500.0000', received: '1000000.0000',
  outstanding: '825000.0000', retentionHeld: '187500.0000',
};

class FakeSales implements SalesReadPort {
  lastScope?: SalesScope;
  ipcBilling(scope: SalesScope): Promise<{ rows: IpcBillingReadRow[]; totals: IpcBillingTotals }> {
    this.lastScope = scope;
    return Promise.resolve({ rows: IPC_ROWS.map((r) => ({ ...r })), totals: { ...IPC_TOTALS } });
  }
}

// ── fake CC: budget-vs-actual verbatim, incl. an UNBUDGETED pair ──
const CC_ROWS: CostCentreVarianceRow[] = [
  { projectId: 'A', costCentreId: 'cc1', budgetedAmount: '1000000.0000', actualCost: '925000.0000', variance: '75000.0000', utilisationPct: '92.5000', status: 'APPROACHING' },
  { projectId: 'A', costCentreId: 'cc9', budgetedAmount: null, actualCost: '30000.0000', variance: null, utilisationPct: null, status: 'UNBUDGETED' },
];

class FakeCostControl implements CostControlReadPort {
  lastScope?: CostControlScope;
  budgetVsActual(scope: CostControlScope): Promise<CostCentreVarianceRow[]> {
    this.lastScope = scope;
    return Promise.resolve(CC_ROWS.map((r) => ({ ...r })));
  }
}

describe('ReportQueryService — project reports (RPT #32)', () => {
  const build = () => {
    const ledger = new FakeLedger();
    const sales = new FakeSales();
    const cc = new FakeCostControl();
    const svc = new ReportQueryService(
      ledger,
      {} as never,
      {} as never,
      {} as never,
      new ReportScopeService(),
      sales,
      cc,
    );
    return { ledger, sales, cc, svc };
  };

  // ── project P&L (FR-RPT-015) ──
  it('project-pnl: per-cost-centre rows + a project total; profit = revenue − cost (verbatim from LED)', async () => {
    const { svc } = build();
    const r = await svc.projectPnl({ financialYearId: 'fy1', projectId: 'A' }, admin);
    expect(r.reportName).toBe('project-pnl');
    // per-cost-centre rows (projectId stamped) + a project total row (costCentreId = null).
    expect(r.rows).toHaveLength(3);
    expect(r.rows.slice(0, 2).every((row) => row.projectId === 'A' && row.costCentreId !== null)).toBe(true);
    const total = r.rows[r.rows.length - 1];
    expect(total).toEqual({ projectId: 'A', costCentreId: null, revenue: '4000.0000', cost: '3200.0000', profit: '800.0000' });
    expect(r.totals).toEqual(PNL_TOTALS);
    // profit = revenue − cost (the port math, rendered — not recomputed).
    expect(total.profit).toBe(String((4000 - 3200).toFixed(4)));
  });

  it('project-pnl: groups LED by cost centre (reuses the P&L aggregation)', async () => {
    const { ledger, svc } = build();
    await svc.projectPnl({ financialYearId: 'fy1', projectId: 'A' }, admin);
    expect(ledger.lastScope?.groupBy).toBe('cost_centre');
    expect(ledger.lastScope?.projectIds).toEqual(['A']);
  });

  // ── IPC billing (FR-RPT-016/-017) — single source of truth ──
  it('ipc-billing: renders SAL figures VERBATIM and ONLY adds the ageing bucket (FR-RPT-004/-017)', async () => {
    const { svc } = build();
    const r = await svc.ipcBilling({ financialYearId: 'fy1', projectId: 'A' }, admin);
    expect(r.reportName).toBe('ipc-billing');
    expect(r.totals).toEqual(IPC_TOTALS); // SAL's cumulative totals, not re-totalled
    // Every SAL money field is byte-identical; RPT added exactly one field (ageingBucket).
    r.rows.forEach((row, i) => {
      const src = IPC_ROWS[i];
      const { ageingBucket, ...rest } = row;
      expect(rest).toEqual(src); // verbatim, no recomputation
      expect(ageingBucket).toBeDefined();
    });
    // ipc-1 due far in the future → CURRENT; ipc-2 due in the year 2000 → D90_PLUS.
    expect(r.rows[0].ageingBucket).toBe('CURRENT');
    expect(r.rows[1].ageingBucket).toBe('D90_PLUS');
  });

  it('ipc-billing: hands the effective project scope to SAL (F4)', async () => {
    const { sales, svc } = build();
    await svc.ipcBilling({ financialYearId: 'fy1' }, pmAB);
    expect(sales.lastScope?.projectIds).toEqual(['A', 'B']);
    expect(sales.lastScope?.companyId).toBe(CO);
  });

  // ── outstanding (FR-RPT-020) ──
  it('outstanding: per-IPC rows + per-project rolled-up totals = Σ its IPC outstanding (reconciles to SAL)', async () => {
    const { svc } = build();
    const r = await svc.outstanding({ financialYearId: 'fy1', projectId: 'A', asOf: '2026-06-30' }, admin);
    expect(r.rows).toHaveLength(2);
    // project A total = 375000 + 450000 = 825000; grand total matches.
    expect(r.totals).toEqual({ A: '825000.0000', outstanding: '825000.0000' });
  });

  // ── cost-centre variance (FR-RPT-025) — single source of truth incl. UNBUDGETED ──
  it('cost-centre-variance: renders CC figures VERBATIM incl. UNBUDGETED (no recomputation, FR-RPT-025)', async () => {
    const { svc } = build();
    const r = await svc.costCentreVariance({ financialYearId: 'fy1', projectId: 'A' }, admin);
    expect(r.rows).toEqual(CC_ROWS); // byte-for-byte CC's rows
    const unbudgeted = r.rows.find((x) => x.status === 'UNBUDGETED')!;
    expect(unbudgeted.budgetedAmount).toBeNull();
    expect(unbudgeted.variance).toBeNull();
    expect(unbudgeted.utilisationPct).toBeNull();
    expect(unbudgeted.actualCost).toBe('30000.0000');
  });

  it('cost-centre-variance: an optional status csv filters rows; an unknown status → ValidationError', async () => {
    const { svc } = build();
    const only = await svc.costCentreVariance({ financialYearId: 'fy1', projectId: 'A', status: 'UNBUDGETED' }, admin);
    expect(only.rows).toHaveLength(1);
    expect(only.rows[0].status).toBe('UNBUDGETED');
    await expect(
      svc.costCentreVariance({ financialYearId: 'fy1', projectId: 'A', status: 'NOPE' }, admin),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('material-consumption-vs-budget: consumes the SAME CC budget-vs-actual verbatim (FR-RPT-018)', async () => {
    const { svc } = build();
    const r = await svc.materialConsumptionVsBudget({ financialYearId: 'fy1', projectId: 'A' }, admin);
    expect(r.reportName).toBe('material-consumption-vs-budget');
    expect(r.rows).toEqual(CC_ROWS);
  });

  // ── labour cost (FR-RPT-019) ──
  it('labour-cost: renders LED labour rows + totals verbatim', async () => {
    const { svc } = build();
    const r = await svc.labourCost({ financialYearId: 'fy1', projectId: 'A' }, admin);
    expect(r.rows).toEqual([{ projectId: 'A', costCentreId: 'cc1', labourCost: '1200.0000' }]);
    expect(r.totals).toEqual({ labourCost: '1200.0000' });
  });

  // ── scope (F4 / F3) ──
  it('scope: a PM filtering an unassigned projectId → 403 (FR-RPT-007)', async () => {
    const { svc } = build();
    await expect(svc.ipcBilling({ financialYearId: 'fy1', projectId: 'A' }, pmB)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.costCentreVariance({ financialYearId: 'fy1', projectId: 'A' }, pmB),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scope: a PM with no assignments gets an empty scope handed to the ports ([] → valid empty report)', async () => {
    const pmNone: Actor = { ...admin, role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [] };
    const { cc, svc } = build();
    await svc.costCentreVariance({ financialYearId: 'fy1' }, pmNone);
    expect(cc.lastScope?.projectIds).toEqual([]);
  });
});
