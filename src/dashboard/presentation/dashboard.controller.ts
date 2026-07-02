/**
 * DashboardController (DSH · PRESENTATION) — the READ-ONLY `/api/dashboard` surface. There is NO
 * POST/PUT/PATCH/DELETE of any kind here (FR-DSH-003): both routes are `GET`s that compose the caller's
 * role-scoped KPI tiles by summarising the RPT reports / module read models and return each tile with its
 * KPI value(s) and a `drillTo`. Guards mirror RPT/LED: `@UseGuards(JwtAuthGuard, RolesGuard)` at class
 * level + `@Roles({ module:'DSH', action:'READ' })` on every route (the DSH:READ gate). Role→tile
 * filtering (which tiles the caller sees) is business logic in DashboardService on top of that gate
 * (FR-DSH-007/-010). The actor is resolved via `@CurrentActor`; company is implicit from the JWT.
 *
 * Responses use the platform `{ data, meta }` envelope (ResponseEnvelopeInterceptor): `GET /api/dashboard`
 * → `data` is the Tile[] the caller may see; `GET /api/dashboard/tiles/:key` → `data` is one Tile.
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ValidationError } from '../../common/errors/domain-error';
import { Actor } from '../../core/tenancy/tenant-context';
import { CurrentActor } from '../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/presentation/roles.guard';
import { Roles } from '../../core/auth/presentation/roles.decorator';
import { DashboardService } from '../application/dashboard.service';
import { DashboardParams } from '../application/dashboard-scope.service';
import { Tile } from '../domain/tile.model';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

@ApiTags('Dashboard')
@Controller('api/dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** The caller's full role-scoped tile set (FR-DSH-001/-005/-007/-010). */
  @Get()
  @Roles({ module: 'DSH', action: 'READ' })
  async getDashboard(
    @Query() q: DashboardQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Tile<unknown>[]> {
    return this.dashboard.assemble(actor, this.toParams(q));
  }

  /** A single tile re-read live (FR-DSH-005); unknown key → 404, role may not see it → 403 (FR-DSH-010). */
  @Get('tiles/:key')
  @Roles({ module: 'DSH', action: 'READ' })
  async tile(
    @Param('key') key: string,
    @Query() q: DashboardQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Tile<unknown>> {
    return this.dashboard.tile(key, actor, this.toParams(q));
  }

  private toParams(q: DashboardQueryDto): DashboardParams {
    if (q.dateFrom && q.dateTo && q.dateFrom > q.dateTo) {
      throw new ValidationError('dateFrom must be <= dateTo', { field: 'dateFrom' });
    }
    return {
      financialYearId: q.financialYearId,
      projectId: q.projectId,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      month: q.month,
      godownId: q.godownId,
      reorderLevel: q.reorderLevel,
    };
  }
}
