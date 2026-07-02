/**
 * ReportQueryService (RPT · FR-RPT-004/-009/-013) on a fake LedgerReadPort. Proves the service reads the
 * owning source verbatim (totals/rows are the port's — no second computation), assembles a ReportResult,
 * resolves the effective project scope into the LedgerScope (F3/F4), and rejects dateFrom > dateTo (§11).
 */
import { ReportQueryService } from '../../../src/reports/application/report-query.service';
import { ReportScopeService } from '../../../src/reports/application/report-scope.service';
import { LedgerReadPort, LedgerScope, PaginatedRows } from '../../../src/reports/domain/ports/ledger.read.port';
import {
  AccountLedgerRow,
  BalanceSheetRow,
  ProjectPnlRow,
  TrialBalanceRow,
} from '../../../src/reports/domain/report-result.model';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const CO = 'company-1';
const admin: Actor = {
  userId: 'u1', companyId: CO, financialYearId: 'fy1', role: 'ADMIN',
  isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pmAB: Actor = { ...admin, role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: ['A', 'B'] };

class FakeLedger implements LedgerReadPort {
  lastScope?: LedgerScope;
  trialBalance(scope: LedgerScope): Promise<{ rows: TrialBalanceRow[]; totals: { debit: string; credit: string } }> {
    this.lastScope = scope;
    return Promise.resolve({
      rows: [
        { accountId: 'a1', projectId: null, costCentreId: null, purposeId: null, godownId: null, partyId: null,
          debit: '500.0000', credit: '0.0000', net: '500.0000' },
      ],
      totals: { debit: '500.0000', credit: '500.0000' },
    });
  }
  profitAndLoss(scope: LedgerScope): Promise<{ rows: ProjectPnlRow[]; totals: { revenue: string; cost: string; profit: string } }> {
    this.lastScope = scope;
    return Promise.resolve({
      rows: [{ projectId: 'A', costCentreId: null, revenue: '4000.0000', cost: '3200.0000', profit: '800.0000' }],
      totals: { revenue: '4000.0000', cost: '3200.0000', profit: '800.0000' },
    });
  }
  accountLedger(scope: LedgerScope): Promise<PaginatedRows<AccountLedgerRow>> {
    this.lastScope = scope;
    return Promise.resolve({ items: [], total: 0, openingBalance: '120000.0000' });
  }
  daybook(scope: LedgerScope): Promise<PaginatedRows<AccountLedgerRow>> {
    this.lastScope = scope;
    return Promise.resolve({ items: [], total: 0 });
  }
  cashBankBook(scope: LedgerScope): Promise<PaginatedRows<AccountLedgerRow>> {
    this.lastScope = scope;
    return Promise.resolve({ items: [], total: 0, openingBalance: '0.0000' });
  }
  balanceSheet(scope: LedgerScope): Promise<{ rows: BalanceSheetRow[]; totals: { assets: string; liabilities: string; equity: string } }> {
    this.lastScope = scope;
    return Promise.resolve({ rows: [], totals: { assets: '0.0000', liabilities: '0.0000', equity: '0.0000' } });
  }
}

describe('ReportQueryService', () => {
  const build = () => {
    const ledger = new FakeLedger();
    // The inventory/requisition/HR ports are exercised by report-query.inventory-hr.service.spec.ts; the
    // LED-report tests here never touch them, so empty stubs suffice.
    const svc = new ReportQueryService(
      ledger,
      {} as never,
      {} as never,
      {} as never,
      new ReportScopeService(),
    );
    return { ledger, svc };
  };

  it('trial balance: returns the port totals verbatim, balances, and assembles a ReportResult', async () => {
    const { svc } = build();
    const r = await svc.trialBalance({ financialYearId: 'fy1' }, admin);
    expect(r.reportName).toBe('trial-balance');
    expect(r.totals).toEqual({ debit: '500.0000', credit: '500.0000' });
    expect(r.totals!.debit).toBe(r.totals!.credit);
    expect(r.rows).toHaveLength(1);
    expect(r.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('P&L: profit = revenue − cost (the port math), rendered verbatim', async () => {
    const { svc } = build();
    const r = await svc.profitAndLoss({ financialYearId: 'fy1', projectId: 'A' }, admin);
    expect(r.totals).toEqual({ revenue: '4000.0000', cost: '3200.0000', profit: '800.0000' });
    expect(r.rows[0].profit).toBe('800.0000');
  });

  it('resolves an unscoped actor to all projects (projectIds null) in the scope handed to the port', async () => {
    const { ledger, svc } = build();
    await svc.trialBalance({ financialYearId: 'fy1' }, admin);
    expect(ledger.lastScope?.projectIds).toBeNull();
    expect(ledger.lastScope?.companyId).toBe(CO);
  });

  it('auto-filters a PM to assigned projects in the scope handed to the port (F4)', async () => {
    const { ledger, svc } = build();
    await svc.trialBalance({ financialYearId: 'fy1' }, pmAB);
    expect(ledger.lastScope?.projectIds).toEqual(['A', 'B']);
  });

  it('account ledger: carries openingBalance into meta and paginates', async () => {
    const { svc } = build();
    const p = await svc.accountLedger({ financialYearId: 'fy1', accountId: 'a1' }, admin);
    expect(p.extraMeta).toEqual({ openingBalance: '120000.0000' });
  });

  it('rejects dateFrom > dateTo with a ValidationError (400)', async () => {
    const { svc } = build();
    await expect(
      svc.daybook({ financialYearId: 'fy1', dateFrom: '2026-06-30', dateTo: '2026-06-01' }, admin),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
