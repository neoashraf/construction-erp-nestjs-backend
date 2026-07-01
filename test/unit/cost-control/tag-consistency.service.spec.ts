/**
 * TagConsistencyServiceImpl (FR-CC-004) — use-case tests on a fake CostControlReadRepository.
 * A line whose purpose belongs to another project → CrossProjectDimensionError; a cross-project godown
 * → error; matching project → passes; no tags → no query. Design §9 "Use-case" scenarios.
 */
import Decimal from 'decimal.js';
import { TagConsistencyServiceImpl } from '../../../src/core/cost-control/application/tag-consistency.service';
import { CrossProjectDimensionError } from '../../../src/core/cost-control/domain/errors';
import {
  CostControlReadRepository,
  LedgerScope,
  PairKey,
  ProfitabilityAgg,
  ProfitGroupBy,
} from '../../../src/core/cost-control/domain/ports/cost-control.read.port';

const CO = 'company-1';
const PROJ_A = 'project-A';
const PROJ_B = 'project-B';

/** The owners among `ids` that exist in `owners` (mirrors the SQL adapter's "missing ids absent"). */
function subset(owners: Map<string, string>, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const owner = owners.get(id);
    if (owner !== undefined) out.set(id, owner);
  }
  return out;
}

class FakeReadRepo implements CostControlReadRepository {
  purposeCalls = 0;
  godownCalls = 0;
  constructor(
    private readonly purposeOwners: Map<string, string>,
    private readonly godownOwners: Map<string, string>,
  ) {}
  actualByPair(_scope: LedgerScope): Promise<Map<PairKey, Decimal>> {
    return Promise.resolve(new Map());
  }
  budgetsByPair(_scope: LedgerScope): Promise<Map<PairKey, Decimal>> {
    return Promise.resolve(new Map());
  }
  profitability(_scope: LedgerScope, _groupBy: ProfitGroupBy): Promise<ProfitabilityAgg[]> {
    return Promise.resolve([]);
  }
  projectOfPurposes(_c: string, ids: string[]): Promise<Map<string, string>> {
    this.purposeCalls += 1;
    return Promise.resolve(subset(this.purposeOwners, ids));
  }
  projectOfGodowns(_c: string, ids: string[]): Promise<Map<string, string>> {
    this.godownCalls += 1;
    return Promise.resolve(subset(this.godownOwners, ids));
  }
}

describe('TagConsistencyServiceImpl.assertConsistent', () => {
  it('passes when purpose + godown belong to the line project', async () => {
    const repo = new FakeReadRepo(
      new Map([['pur-1', PROJ_A]]),
      new Map([['gd-1', PROJ_A]]),
    );
    const svc = new TagConsistencyServiceImpl(repo);
    await expect(
      svc.assertConsistent({ companyId: CO }, [
        { projectId: PROJ_A, purposeId: 'pur-1', godownId: 'gd-1' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('rejects a purpose belonging to another project (FR-CC-004)', async () => {
    const repo = new FakeReadRepo(new Map([['pur-1', PROJ_B]]), new Map());
    const svc = new TagConsistencyServiceImpl(repo);
    await expect(
      svc.assertConsistent({ companyId: CO }, [{ projectId: PROJ_A, purposeId: 'pur-1' }]),
    ).rejects.toBeInstanceOf(CrossProjectDimensionError);
  });

  it('rejects a cross-project godown (FR-CC-004)', async () => {
    const repo = new FakeReadRepo(new Map(), new Map([['gd-9', PROJ_B]]));
    const svc = new TagConsistencyServiceImpl(repo);
    await expect(
      svc.assertConsistent({ companyId: CO }, [{ projectId: PROJ_A, godownId: 'gd-9' }]),
    ).rejects.toBeInstanceOf(CrossProjectDimensionError);
  });

  it('rejects a dangling purpose id (owner unknown ≠ line project)', async () => {
    const repo = new FakeReadRepo(new Map(), new Map());
    const svc = new TagConsistencyServiceImpl(repo);
    await expect(
      svc.assertConsistent({ companyId: CO }, [{ projectId: PROJ_A, purposeId: 'missing' }]),
    ).rejects.toBeInstanceOf(CrossProjectDimensionError);
  });

  it('makes no lookup when no line carries a purpose/godown', async () => {
    const repo = new FakeReadRepo(new Map(), new Map());
    const svc = new TagConsistencyServiceImpl(repo);
    await svc.assertConsistent({ companyId: CO }, [
      { projectId: PROJ_A, purposeId: null, godownId: null },
    ]);
    expect(repo.purposeCalls).toBe(0);
    expect(repo.godownCalls).toBe(0);
  });
});
