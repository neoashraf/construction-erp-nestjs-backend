/**
 * DashboardScopeService (DSH · FR-DSH-007/-008/-009/-010) — application. Resolves, before any source is
 * read: (a) TILE VISIBILITY — the tiles the caller's role may see (overview §2) — and (b) the effective
 * COMPANY + PROJECT scope every tile runs under. It REUSES RPT's `ReportScopeService` for the project
 * boundary (F3 company from the actor; F4 assigned-projects filter; an explicit unassigned `projectId` →
 * 403; a PM with no assignments → `[]` → valid zero tiles), so DSH and RPT resolve scope identically.
 * Role visibility is DSH business logic on top of the controller's `DSH:READ` gate (FR-DSH-010).
 */
import { Injectable } from '@nestjs/common';
import { Actor } from '../../core/tenancy/tenant-context';
import { ReportScopeService } from '../../reports/application/report-scope.service';
import { TileDescriptor } from '../domain/tile-descriptor';
import { TILE_CATALOG } from '../domain/tile-catalog';

/** Tile-scope window params (each tile reads only the ones it uses). */
export interface DashboardParams {
  financialYearId?: string;
  projectId?: string;
  dateFrom?: string;
  dateTo?: string;
  month?: string;
  /** Low-stock re-order threshold (RPT report param — MAS holds no reorder attribute; SRS edge 9). */
  reorderLevel?: string;
  godownId?: string;
}

/** The resolved scope carried into every read port + used to build each tile's drill-down params. */
export interface TileScope {
  companyId: string;
  /** Effective project filter (F4): `null` = all; `[]` = none (zero tiles); `[ids]` = restricted. */
  projectIds: string[] | null;
  financialYearId?: string;
  dateFrom?: string;
  dateTo?: string;
  month?: string;
  reorderLevel?: string;
  godownId?: string;
  /** The projectId the caller explicitly requested (for the drill-down params), or null. */
  requestedProjectId: string | null;
}

@Injectable()
export class DashboardScopeService {
  constructor(private readonly reportScope: ReportScopeService) {}

  /** The catalog tiles the caller's role may see (FR-DSH-007/-010). */
  visibleTiles(actor: Actor): TileDescriptor[] {
    return TILE_CATALOG.filter((t) => this.canSee(actor, t));
  }

  /** Whether the caller's role may see this tile (overview §2). */
  canSee(actor: Actor, descriptor: TileDescriptor): boolean {
    return descriptor.roles.includes(actor.role);
  }

  /**
   * Resolve company (F3) + effective project filter (F4) + the tile window. Throws Nest ForbiddenException
   * (via ReportScopeService) when a project-scoped caller supplies an unassigned `projectId` (FR-DSH-009).
   */
  resolve(actor: Actor, params: DashboardParams): TileScope {
    const { companyId, projectIds } = this.reportScope.resolve(actor, params.projectId);
    return {
      companyId,
      projectIds,
      financialYearId: params.financialYearId,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      month: params.month,
      reorderLevel: params.reorderLevel,
      godownId: params.godownId,
      requestedProjectId: params.projectId ?? null,
    };
  }
}
