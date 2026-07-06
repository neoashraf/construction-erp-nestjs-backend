/**
 * TileQueryService (DSH · FR-DSH-004/-011…018) on fake read ports. Proves each tile's KPI is a VERBATIM
 * summary of its owning source (no recomputation): over-budget counts CC's OVER/APPROACHING rows;
 * pending-ipcs counts outstanding>0 and renders SAL's outstanding total; retention-held renders SAL's
 * retention total; low-stock counts INV rows and renders BREACH/OK; attendance sums HR's roll-up; cash-flow
 * and top-receivables/payables render LED's figures ordered by outstanding. Also proves status is the
 * source's classification rendered (FR-DSH-018) and drillTo carries the tile's scope (FR-DSH-002).
 */
import { TileQueryService } from '../../../src/dashboard/application/tile-query.service';
import { TileScope } from '../../../src/dashboard/application/dashboard-scope.service';
import { findTile } from '../../../src/dashboard/domain/tile-catalog';
import {
  CashFlowKpi,
  LowStockKpi,
  OverBudgetKpi,
  PendingIpcKpi,
  RetentionHeldKpi,
  TopReceivablePayableKpi,
  AttendanceKpi,
} from '../../../src/dashboard/domain/tile.model';
import {
  FakeCostControl,
  FakeHr,
  FakeInventory,
  FakeLedger,
  FakeSales,
  attRow,
  ccRow,
  ipcRow,
  partyRow,
  stockRow,
} from './fakes';

const SCOPE: TileScope = {
  companyId: 'co',
  projectIds: null,
  financialYearId: 'fy1',
  requestedProjectId: null,
};

function build(opts: {
  cc?: FakeCostControl;
  sales?: FakeSales;
  inv?: FakeInventory;
  hr?: FakeHr;
  ledger?: FakeLedger;
}) {
  return new TileQueryService(
    opts.cc ?? new FakeCostControl(),
    opts.sales ?? new FakeSales(),
    opts.inv ?? new FakeInventory(),
    opts.hr ?? new FakeHr(),
    opts.ledger ?? new FakeLedger(),
  );
}

describe('TileQueryService — single source of truth (FR-DSH-004)', () => {
  it('over-budget counts CC OVER/APPROACHING rows VERBATIM and renders the worst status (FR-DSH-015/-018)', async () => {
    const cc = new FakeCostControl([
      ccRow('OVER'),
      ccRow('OVER'),
      ccRow('APPROACHING'),
      ccRow('OK'),
      ccRow('UNBUDGETED'),
    ]);
    const tile = await build({ cc }).compute(findTile('over-budget')!, SCOPE);
    expect(tile.kpi as OverBudgetKpi).toEqual({ overCount: 2, approachingCount: 1 });
    expect(tile.status).toBe('OVER');
    expect(cc.lastScope).toMatchObject({ companyId: 'co', projectIds: null, financialYearId: 'fy1' });
  });

  it('over-budget status APPROACHING when no OVER rows; OK when none (FR-DSH-018)', async () => {
    const approaching = await build({ cc: new FakeCostControl([ccRow('APPROACHING'), ccRow('OK')]) }).compute(
      findTile('over-budget')!,
      SCOPE,
    );
    expect(approaching.status).toBe('APPROACHING');
    const ok = await build({ cc: new FakeCostControl([ccRow('OK'), ccRow('UNBUDGETED')]) }).compute(
      findTile('over-budget')!,
      SCOPE,
    );
    expect(ok.status).toBe('OK');
    expect((ok.kpi as OverBudgetKpi)).toEqual({ overCount: 0, approachingCount: 0 });
  });

  it('pending-ipcs counts outstanding>0 and sums SAL outstanding VERBATIM (FR-DSH-012)', async () => {
    const sales = new FakeSales(
      [ipcRow('500.0000'), ipcRow('0.0000'), ipcRow('250.0000')],
      { certified: '0.0000', billed: '0.0000', received: '0.0000', outstanding: '750.0000', retentionHeld: '412500.0000' },
    );
    const tile = await build({ sales }).compute(findTile('pending-ipcs')!, SCOPE);
    expect(tile.kpi as PendingIpcKpi).toEqual({ count: 2, totalOutstanding: '750.0000' });
    expect(tile.status).toBeNull();
  });

  it('retention-held renders SAL retention total VERBATIM (FR-DSH-013)', async () => {
    const sales = new FakeSales(
      [ipcRow('0.0000', '100.0000')],
      { certified: '0.0000', billed: '0.0000', received: '0.0000', outstanding: '0.0000', retentionHeld: '412500.0000' },
    );
    const tile = await build({ sales }).compute(findTile('retention-held')!, SCOPE);
    expect(tile.kpi as RetentionHeldKpi).toEqual({ totalRetentionHeld: '412500.0000' });
  });

  it('low-stock counts INV rows and renders BREACH when >0, OK when 0 (FR-DSH-014/-018)', async () => {
    const breach = await build({ inv: new FakeInventory([stockRow(), stockRow(), stockRow()]) }).compute(
      findTile('low-stock')!,
      { ...SCOPE, reorderLevel: '10' },
    );
    expect(breach.kpi as LowStockKpi).toEqual({ count: 3 });
    expect(breach.status).toBe('BREACH');
    const ok = await build({ inv: new FakeInventory([]) }).compute(findTile('low-stock')!, SCOPE);
    expect((ok.kpi as LowStockKpi).count).toBe(0);
    expect(ok.status).toBe('OK');
  });

  it('attendance sums HR present-days + head count for the scope (FR-DSH-016)', async () => {
    const hr = new FakeHr([attRow(20, 5), attRow(18, 3)]);
    const tile = await build({ hr }).compute(findTile('attendance-summary')!, { ...SCOPE, month: '2026-06' });
    expect(tile.kpi as AttendanceKpi).toEqual({ period: '2026-06', presentDays: 38, headCountTotal: '8.0000' });
    expect(hr.lastScope).toMatchObject({ month: '2026-06' });
  });

  it('cash-flow renders LED figures VERBATIM (FR-DSH-011)', async () => {
    const cash: CashFlowKpi = { netInflow: '1250000.0000', cashBalance: '320000.0000', bankBalance: '4100000.0000' };
    const tile = await build({ ledger: new FakeLedger(cash) }).compute(findTile('project-cash-flow')!, SCOPE);
    expect(tile.kpi as CashFlowKpi).toEqual(cash);
  });

  it('top-receivables/payables returns LED rows ordered by outstanding (FR-DSH-017)', async () => {
    const ledger = new FakeLedger(
      undefined,
      [partyRow('r1', 'জনতা বিল্ডার্স', '920000.0000'), partyRow('r2', 'B', '10000.0000')],
      [partyRow('p1', 'Padma Cement Ltd', '640000.0000')],
    );
    const tile = await build({ ledger }).compute(findTile('top-receivables-payables')!, SCOPE);
    const kpi = tile.kpi as TopReceivablePayableKpi;
    expect(kpi.topReceivables[0]).toEqual({ partyId: 'r1', partyName: 'জনতা বিল্ডার্স', outstanding: '920000.0000' });
    expect(kpi.topPayables[0].partyName).toBe('Padma Cement Ltd');
  });
});

describe('TileQueryService — drillTo carries the tile scope (FR-DSH-002)', () => {
  it('every tile drillTo names its RPT report and carries financialYear/project scope', async () => {
    const scope: TileScope = { ...SCOPE, requestedProjectId: 'projX', dateFrom: '2026-06-01', dateTo: '2026-06-30' };
    const svc = build({});
    for (const key of [
      'project-cash-flow',
      'pending-ipcs',
      'retention-held',
      'low-stock',
      'over-budget',
      'attendance-summary',
      'top-receivables-payables',
    ]) {
      const tile = await svc.compute(findTile(key)!, scope);
      expect(tile.drillTo.report).toBe(findTile(key)!.drillToReport);
      expect(tile.drillTo.params).toMatchObject({ financialYearId: 'fy1', projectId: 'projX' });
    }
  });

  it('over-budget drillTo carries the OVER,APPROACHING status filter; retention carries view=retention', async () => {
    const svc = build({});
    const ob = await svc.compute(findTile('over-budget')!, SCOPE);
    expect(ob.drillTo.params.status).toBe('OVER,APPROACHING');
    const ret = await svc.compute(findTile('retention-held')!, SCOPE);
    expect(ret.drillTo.params.view).toBe('retention');
  });
});
