/**
 * BudgetCheckServiceImpl (FR-CC-013/014) — use-case tests on a fake CostControlReadRepository.
 * Proves: current actual + draft pushes a pair OK→OVER while another stays OK; an unbudgeted pair
 * returns UNBUDGETED; exactly one result per distinct (project, cost centre); the call NEVER throws on
 * OVER and NEVER blocks. Design §9 "Use-case" scenarios.
 */
import Decimal from 'decimal.js';
import { BudgetCheckServiceImpl } from '../../../src/core/cost-control/application/budget-check.service';
import {
  CostControlReadRepository,
  LedgerScope,
  PairKey,
  pairKey,
  ProfitabilityAgg,
  ProfitGroupBy,
} from '../../../src/core/cost-control/domain/ports/cost-control.read.port';

const CO = 'company-1';
const P = 'project-1';
const SLAB = 'cc-slab';
const PLASTER = 'cc-plaster';

class FakeReadRepo implements CostControlReadRepository {
  constructor(
    private readonly actuals: Map<PairKey, Decimal>,
    private readonly budgets: Map<PairKey, Decimal>,
  ) {}
  actualByPair(_scope: LedgerScope): Promise<Map<PairKey, Decimal>> {
    return Promise.resolve(this.actuals);
  }
  budgetsByPair(_scope: LedgerScope): Promise<Map<PairKey, Decimal>> {
    return Promise.resolve(this.budgets);
  }
  profitability(_scope: LedgerScope, _groupBy: ProfitGroupBy): Promise<ProfitabilityAgg[]> {
    return Promise.resolve([]);
  }
  projectOfPurposes(_c: string, _ids: string[]): Promise<Map<string, string>> {
    return Promise.resolve(new Map());
  }
  projectOfGodowns(_c: string, _ids: string[]): Promise<Map<string, string>> {
    return Promise.resolve(new Map());
  }
}

const D = (v: string | number) => new Decimal(v);

describe('BudgetCheckServiceImpl.checkProspective', () => {
  it('pushes (P, Slab) OK→OVER while (P, Plaster) stays OK; one row per pair', async () => {
    const actuals = new Map([
      [pairKey(P, SLAB), D(900_000)],
      [pairKey(P, PLASTER), D(100_000)],
    ]);
    const budgets = new Map([
      [pairKey(P, SLAB), D(1_000_000)],
      [pairKey(P, PLASTER), D(1_000_000)],
    ]);
    const svc = new BudgetCheckServiceImpl(new FakeReadRepo(actuals, budgets));

    const results = await svc.checkProspective({ companyId: CO }, [
      { projectId: P, costCentreId: SLAB, amount: D(200_000) }, // 900k + 200k = 1.1m → OVER
      { projectId: P, costCentreId: PLASTER, amount: D(50_000) }, // 100k + 50k = 150k → OK
    ]);

    expect(results).toHaveLength(2);
    const slab = results.find((r) => r.costCentreId === SLAB)!;
    expect(slab.status).toBe('OVER');
    expect(slab.currentActual.toFixed(4)).toBe('900000.0000');
    expect(slab.draftAmount.toFixed(4)).toBe('200000.0000');
    expect(slab.projectedUtilisationPct!.toFixed(4)).toBe('110.0000');

    const plaster = results.find((r) => r.costCentreId === PLASTER)!;
    expect(plaster.status).toBe('OK');
  });

  it('sums multiple draft lines for the same (project, cost centre) into one result', async () => {
    const svc = new BudgetCheckServiceImpl(
      new FakeReadRepo(new Map([[pairKey(P, SLAB), D(0)]]), new Map([[pairKey(P, SLAB), D(1000)]])),
    );
    const results = await svc.checkProspective({ companyId: CO }, [
      { projectId: P, costCentreId: SLAB, amount: D(400) },
      { projectId: P, costCentreId: SLAB, amount: D(600) },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.draftAmount.toFixed(4)).toBe('1000.0000');
    expect(results[0]!.status).toBe('OVER'); // 1000/1000 = 100%
  });

  it('returns UNBUDGETED for a pair with no positive budget and never throws', async () => {
    const svc = new BudgetCheckServiceImpl(
      new FakeReadRepo(new Map([[pairKey(P, SLAB), D(5000)]]), new Map()),
    );
    const results = await svc.checkProspective({ companyId: CO }, [
      { projectId: P, costCentreId: SLAB, amount: D(1000) },
    ]);
    expect(results[0]!.status).toBe('UNBUDGETED');
    expect(results[0]!.budgetedAmount).toBeNull();
    expect(results[0]!.projectedUtilisationPct).toBeNull();
  });

  it('returns [] for an empty draft', async () => {
    const svc = new BudgetCheckServiceImpl(new FakeReadRepo(new Map(), new Map()));
    expect(await svc.checkProspective({ companyId: CO }, [])).toEqual([]);
  });
});
