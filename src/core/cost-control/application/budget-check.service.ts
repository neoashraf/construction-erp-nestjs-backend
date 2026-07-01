/**
 * BudgetCheckServiceImpl (CC application) — the advisory prospective over-budget check (FR-CC-013/014).
 * Groups the draft's cost lines by (project, cost centre), reads the CURRENT lifetime actual and the
 * budget for those pairs, and classifies `actual + draft`. It NEVER throws on OVER and NEVER blocks —
 * a plain read, no transaction, no lock (SRS §5.1). Consumed in-process by voucher use cases and over
 * HTTP by `POST /api/cost-control/budget-check`.
 */
import Decimal from 'decimal.js';
import { Inject, Injectable } from '@nestjs/common';
import { classify } from '../domain/cost-control.policy';
import {
  BudgetCheckService,
  CompanyFyContext,
  DraftCostLine,
  ProspectiveResult,
} from '../domain/ports/budget-check.service.port';
import {
  COST_CONTROL_READ_REPOSITORY,
  CostControlReadRepository,
  pairKey,
} from '../domain/ports/cost-control.read.port';

@Injectable()
export class BudgetCheckServiceImpl implements BudgetCheckService {
  constructor(
    @Inject(COST_CONTROL_READ_REPOSITORY)
    private readonly repo: CostControlReadRepository,
  ) {}

  async checkProspective(ctx: CompanyFyContext, lines: DraftCostLine[]): Promise<ProspectiveResult[]> {
    if (lines.length === 0) return [];

    // Sum this draft's amounts per distinct (project, cost centre).
    const drafts = new Map<string, { projectId: string; costCentreId: string; amount: Decimal }>();
    for (const l of lines) {
      const key = pairKey(l.projectId, l.costCentreId);
      const prev = drafts.get(key);
      drafts.set(key, {
        projectId: l.projectId,
        costCentreId: l.costCentreId,
        amount: (prev?.amount ?? new Decimal(0)).plus(l.amount),
      });
    }

    // Current lifetime actual + budgets, restricted to the draft's projects (over-budget is lifetime).
    const projectIds = [...new Set([...drafts.values()].map((d) => d.projectId))];
    const scope = { companyId: ctx.companyId, assignedProjectIds: projectIds };
    const [actuals, budgets] = await Promise.all([
      this.repo.actualByPair(scope),
      this.repo.budgetsByPair(scope),
    ]);

    const results: ProspectiveResult[] = [];
    for (const [key, d] of drafts) {
      const currentActual = actuals.get(key) ?? new Decimal(0);
      const budgetedAmount = budgets.get(key) ?? null;
      const projected = currentActual.plus(d.amount);
      const { status, utilisationPct } = classify(budgetedAmount, projected);
      results.push({
        projectId: d.projectId,
        costCentreId: d.costCentreId,
        currentActual,
        draftAmount: d.amount,
        budgetedAmount,
        projectedUtilisationPct: utilisationPct,
        status,
      });
    }
    return results;
  }
}
