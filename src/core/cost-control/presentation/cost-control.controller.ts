/**
 * CostControlController (PRESENTATION) — `/api/cost-control/*`, all READ + one ADVISORY endpoint. CC
 * owns no write endpoint: budget-vs-actual, profitability, and alerts read the LED ledger + MAS
 * budgets; `budget-check` is a read that carries draft lines in a POST body and NEVER blocks a post
 * (FR-CC-014). Company is implicit from the JWT; a PM is restricted to assigned projects (F4) — an
 * explicit filter on an unassigned project is rejected 403. Guards: `@UseGuards(JwtAuthGuard,
 * RolesGuard)` at class level + `@Roles({module:'CC', action:'READ'})` on every route incl.
 * `budget-check` (advisory only, FR-CC-014 — still gated as a READ), mirroring `period.controller.ts`
 * (per-fy-lock-error) — FR-AUD-012/013/017. The actor is resolved via `@CurrentActor`.
 */
import { Body, Controller, ForbiddenException, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import Decimal from 'decimal.js';
import { Actor } from '../../tenancy/tenant-context';
import { CurrentActor } from '../../auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/roles.guard';
import { Roles } from '../../auth/presentation/roles.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import {
  BudgetVsActualRow,
  CostControlQueryService,
  ProfitabilityRow,
} from '../application/cost-control-query.service';
import {
  BUDGET_CHECK_SERVICE,
  type BudgetCheckService,
} from '../domain/ports/budget-check.service.port';
import {
  AlertsQueryDto,
  BudgetCheckBodyDto,
  BudgetVsActualQueryDto,
  ProfitabilityQueryDto,
} from './dto/cost-control-query.dto';

const MONEY_SCALE = 4;
const UTIL_SCALE = 4;

interface ProspectiveResultDto {
  projectId: string;
  costCentreId: string;
  currentActual: string;
  draftAmount: string;
  budgetedAmount: string | null;
  projectedUtilisationPct: string | null;
  status: string;
}

@ApiTags('Cost Control')
@Controller('api/cost-control')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CostControlController {
  constructor(
    private readonly query: CostControlQueryService,
    @Inject(BUDGET_CHECK_SERVICE) private readonly budgetCheck: BudgetCheckService,
  ) {}

  @Get('budget-vs-actual')
  @Roles({ module: 'CC', action: 'READ' })
  budgetVsActual(
    @Query() q: BudgetVsActualQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<BudgetVsActualRow>> {
    this.assertProjectInScope(actor, q.projectId);
    return this.query.budgetVsActual(q, actor);
  }

  @Get('profitability')
  @Roles({ module: 'CC', action: 'READ' })
  profitability(
    @Query() q: ProfitabilityQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<ProfitabilityRow>> {
    this.assertProjectInScope(actor, q.projectId);
    return this.query.profitability(q, actor);
  }

  @Get('alerts')
  @Roles({ module: 'CC', action: 'READ' })
  alerts(
    @Query() q: AlertsQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<BudgetVsActualRow>> {
    this.assertProjectInScope(actor, q.projectId);
    return this.query.alerts(q, actor);
  }

  @Post('budget-check')
  @Roles({ module: 'CC', action: 'READ' })
  async budgetCheckEndpoint(
    @Body() body: BudgetCheckBodyDto,
    @CurrentActor() actor: Actor,
  ): Promise<ProspectiveResultDto[]> {
    const results = await this.budgetCheck.checkProspective(
      { companyId: actor.companyId, financialYearId: actor.financialYearId || undefined },
      body.lines.map((l) => ({
        projectId: l.projectId,
        costCentreId: l.costCentreId,
        amount: new Decimal(l.amount),
      })),
    );
    return results.map((r) => ({
      projectId: r.projectId,
      costCentreId: r.costCentreId,
      currentActual: r.currentActual.toFixed(MONEY_SCALE),
      draftAmount: r.draftAmount.toFixed(MONEY_SCALE),
      budgetedAmount: r.budgetedAmount !== null ? r.budgetedAmount.toFixed(MONEY_SCALE) : null,
      projectedUtilisationPct:
        r.projectedUtilisationPct !== null ? r.projectedUtilisationPct.toFixed(UTIL_SCALE) : null,
      status: r.status,
    }));
  }

  /** A scoped (PM) actor may not explicitly filter a project outside their assignments (FR-CC-016). */
  private assertProjectInScope(actor: Actor, projectId?: string): void {
    if (projectId && !actor.isUnscoped && !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('FORBIDDEN');
    }
  }
}
