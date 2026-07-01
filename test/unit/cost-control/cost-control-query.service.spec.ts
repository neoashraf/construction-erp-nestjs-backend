/**
 * CostControlQueryService (FR-CC-006/007/008/009/016) — use-case tests on a fake read repo.
 * Proves the budget∪actual union (budgeted-zero-actual row appears; actual-unbudgeted row is
 * UNBUDGETED), variance/utilisation, the status filter, profit = revenue − cost, and that alerts keep
 * only OVER/APPROACHING. HTTP scoping/pagination are exercised in the integration test.
 */
import Decimal from 'decimal.js';
import {
  CostControlQueryService,
} from '../../../src/core/cost-control/application/cost-control-query.service';
import {
  CostControlReadRepository,
  LedgerScope,
  PairKey,
  pairKey,
  ProfitabilityAgg,
  ProfitGroupBy,
} from '../../../src/core/cost-control/domain/ports/cost-control.read.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const CO = 'company-1';
const P = 'project-1';
const SLAB = 'cc-slab';
const PLASTER = 'cc-plaster';
const UNBUDG = 'cc-unbudgeted';

const D = (v: string | number) => new Decimal(v);

const admin: Actor = {
  userId: 'u1', companyId: CO, financialYearId: 'fy1', role: 'Admin',
  isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};

class FakeReadRepo implements CostControlReadRepository {
  constructor(
    private readonly actuals: Map<PairKey, Decimal>,
    private readonly budgets: Map<PairKey, Decimal>,
    private readonly profit: ProfitabilityAgg[] = [],
  ) {}
  actualByPair(_s: LedgerScope): Promise<Map<PairKey, Decimal>> {
    return Promise.resolve(this.actuals);
  }
  budgetsByPair(_s: LedgerScope): Promise<Map<PairKey, Decimal>> {
    return Promise.resolve(this.budgets);
  }
  profitability(_s: LedgerScope, _g: ProfitGroupBy): Promise<ProfitabilityAgg[]> {
    return Promise.resolve(this.profit);
  }
  projectOfPurposes(): Promise<Map<string, string>> {
    return Promise.resolve(new Map());
  }
  projectOfGodowns(): Promise<Map<string, string>> {
    return Promise.resolve(new Map());
  }
}

describe('CostControlQueryService.budgetVsActual', () => {
  const repo = new FakeReadRepo(
    new Map([
      [pairKey(P, SLAB), D(925_000)], // budgeted, APPROACHING
      [pairKey(P, UNBUDG), D(5_000)], // actual but no budget → UNBUDGETED
    ]),
    new Map([
      [pairKey(P, SLAB), D(1_000_000)],
      [pairKey(P, PLASTER), D(300_000)], // budgeted, zero actual → OK, appears
    ]),
  );
  const svc = new CostControlQueryService(repo);

  it('unions budgeted and actual pairs with variance/utilisation/status', async () => {
    const page = await svc.budgetVsActual({}, admin);
    expect(page.total).toBe(3);
    const bySlab = page.items.find((r) => r.costCentreId === SLAB)!;
    expect(bySlab).toMatchObject({
      budgetedAmount: '1000000.0000',
      actualCost: '925000.0000',
      variance: '75000.0000',
      utilisationPct: '92.5000',
      status: 'APPROACHING',
    });
    const plaster = page.items.find((r) => r.costCentreId === PLASTER)!;
    expect(plaster).toMatchObject({ actualCost: '0.0000', status: 'OK' });
    const unbudg = page.items.find((r) => r.costCentreId === UNBUDG)!;
    expect(unbudg).toMatchObject({ budgetedAmount: null, variance: null, utilisationPct: null, status: 'UNBUDGETED' });
  });

  it('applies the status filter', async () => {
    const page = await svc.budgetVsActual({ status: 'UNBUDGETED' }, admin);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.status).toBe('UNBUDGETED');
  });

  it('rejects dateFrom > dateTo', async () => {
    await expect(
      svc.budgetVsActual({ dateFrom: '2025-12-31', dateTo: '2025-01-01' }, admin),
    ).rejects.toThrow();
  });
});

describe('CostControlQueryService.profitability', () => {
  it('computes profit = revenue − cost', async () => {
    const repo = new FakeReadRepo(new Map(), new Map(), [
      { projectId: null, costCentreId: SLAB, revenue: D(4_000_000), cost: D(3_200_000) },
    ]);
    const svc = new CostControlQueryService(repo);
    const page = await svc.profitability({ groupBy: 'cost_centre' }, admin);
    expect(page.items[0]).toMatchObject({
      costCentreId: SLAB, revenue: '4000000.0000', cost: '3200000.0000', profit: '800000.0000',
    });
  });

  it('rejects an unknown groupBy token', async () => {
    const svc = new CostControlQueryService(new FakeReadRepo(new Map(), new Map()));
    await expect(svc.profitability({ groupBy: 'nonsense' }, admin)).rejects.toThrow();
  });
});

describe('CostControlQueryService.alerts', () => {
  it('keeps only OVER/APPROACHING rows', async () => {
    const repo = new FakeReadRepo(
      new Map([
        [pairKey(P, SLAB), D(1_200_000)], // OVER
        [pairKey(P, PLASTER), D(10_000)], // OK
      ]),
      new Map([
        [pairKey(P, SLAB), D(1_000_000)],
        [pairKey(P, PLASTER), D(1_000_000)],
      ]),
    );
    const svc = new CostControlQueryService(repo);
    const page = await svc.alerts({}, admin);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ costCentreId: SLAB, status: 'OVER' });
  });

  it('rejects a status outside OVER,APPROACHING', async () => {
    const svc = new CostControlQueryService(new FakeReadRepo(new Map(), new Map()));
    await expect(svc.alerts({ status: 'OK' }, admin)).rejects.toThrow();
  });
});
