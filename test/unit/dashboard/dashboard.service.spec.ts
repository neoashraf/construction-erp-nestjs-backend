/**
 * DashboardService + DashboardScopeService (DSH · FR-DSH-005/-007/-008/-009/-010) on fake ports + the REAL
 * ReportScopeService (reused for the F3/F4 boundary). Proves role-scoped assembly (Store Keeper → only
 * low-stock; HR → only attendance; Accounts → the financial set; Admin → all 7; an unseen tile is ABSENT,
 * not blanked), single-tile 404/403, and project scoping (a PM is auto-filtered to assigned projects; an
 * explicit unassigned projectId is 403; a PM with no assignments gets valid zero-scoped tiles).
 */
import { ForbiddenException } from '@nestjs/common';
import { DashboardService } from '../../../src/dashboard/application/dashboard.service';
import { DashboardScopeService } from '../../../src/dashboard/application/dashboard-scope.service';
import { TileQueryService } from '../../../src/dashboard/application/tile-query.service';
import { ReportScopeService } from '../../../src/reports/application/report-scope.service';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { UnknownTileError, TileNotPermittedError } from '../../../src/dashboard/domain/errors';
import { FakeCostControl, FakeHr, FakeInventory, FakeLedger, FakeSales } from './fakes';

const base: Actor = {
  userId: 'u', companyId: 'co', financialYearId: 'fy1', role: 'ADMIN',
  isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const admin = base;
const accounts: Actor = { ...base, role: 'ACCOUNTS_TEAM' };
const hr: Actor = { ...base, role: 'HR_MANAGER', isUnscoped: false };
const store: Actor = { ...base, role: 'STORE_KEEPER', isUnscoped: false, assignedProjectIds: ['P'] };
const pmAB: Actor = { ...base, role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: ['A', 'B'] };
const pmNone: Actor = { ...base, role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [] };

function build() {
  const cc = new FakeCostControl();
  const sales = new FakeSales();
  const inv = new FakeInventory();
  const hrPort = new FakeHr();
  const ledger = new FakeLedger();
  const tiles = new TileQueryService(cc, sales, inv, hrPort, ledger);
  const scope = new DashboardScopeService(new ReportScopeService());
  const service = new DashboardService(scope, tiles);
  return { service, cc, sales, inv, hrPort, ledger };
}

const keysOf = (arr: { key: string }[]) => arr.map((t) => t.key).sort();

describe('DashboardService — role-scoped assembly (FR-DSH-007/-010)', () => {
  it('Store Keeper sees ONLY the low-stock tile', async () => {
    const tiles = await build().service.assemble(store, {});
    expect(keysOf(tiles)).toEqual(['low-stock']);
  });

  it('HR Manager sees ONLY the attendance-summary tile', async () => {
    const tiles = await build().service.assemble(hr, {});
    expect(keysOf(tiles)).toEqual(['attendance-summary']);
  });

  it('Accounts sees the full financial set (no attendance) — unseen tile ABSENT, not blanked', async () => {
    const tiles = await build().service.assemble(accounts, { financialYearId: 'fy1' });
    expect(keysOf(tiles)).toEqual(
      ['low-stock', 'over-budget', 'pending-ipcs', 'project-cash-flow', 'retention-held', 'top-receivables-payables'].sort(),
    );
    expect(keysOf(tiles)).not.toContain('attendance-summary');
  });

  it('Admin sees all seven tiles', async () => {
    const tiles = await build().service.assemble(admin, {});
    expect(tiles).toHaveLength(7);
  });

  it('a PM sees the project set (no top-receivables/payables, no attendance)', async () => {
    const tiles = await build().service.assemble(pmAB, {});
    expect(keysOf(tiles)).toEqual(['low-stock', 'over-budget', 'pending-ipcs', 'project-cash-flow', 'retention-held'].sort());
  });
});

describe('DashboardService — single tile (FR-DSH-005/-010)', () => {
  it('unknown key → UnknownTileError (404)', async () => {
    await expect(build().service.tile('nope', admin, {})).rejects.toBeInstanceOf(UnknownTileError);
  });

  it('a tile the role may not see → TileNotPermittedError (403), independent of project scope', async () => {
    // Store Keeper may not see over-budget.
    await expect(build().service.tile('over-budget', store, {})).rejects.toBeInstanceOf(TileNotPermittedError);
    // HR may not see low-stock.
    await expect(build().service.tile('low-stock', hr, {})).rejects.toBeInstanceOf(TileNotPermittedError);
  });

  it('a visible tile is computed live', async () => {
    const tile = await build().service.tile('low-stock', store, {});
    expect(tile.key).toBe('low-stock');
  });
});

describe('DashboardService — project scope (FR-DSH-008/-009)', () => {
  it('a PM with no projectId is auto-filtered to assigned projects', async () => {
    const { service, cc } = build();
    await service.assemble(pmAB, { financialYearId: 'fy1' });
    expect(cc.lastScope!.projectIds).toEqual(['A', 'B']);
  });

  it('a PM filtering an explicit unassigned projectId → 403 (not empty)', async () => {
    await expect(build().service.assemble(pmAB, { projectId: 'C' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(build().service.tile('over-budget', pmAB, { projectId: 'C' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a PM with no assignments gets valid zero-scoped tiles (projectIds = [])', async () => {
    const { service, cc } = build();
    const tiles = await service.assemble(pmNone, { financialYearId: 'fy1' });
    expect(tiles.length).toBeGreaterThan(0); // tiles present, just empty-scoped
    expect(cc.lastScope!.projectIds).toEqual([]);
  });

  it('an Accounts (unscoped) user is not project-restricted (projectIds = null)', async () => {
    const { service, cc } = build();
    await service.assemble(accounts, { financialYearId: 'fy1' });
    expect(cc.lastScope!.projectIds).toBeNull();
  });
});
