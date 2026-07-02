/**
 * DashboardService (DSH · FR-DSH-005/-007/-010) — application. The two entry points behind the read-only
 * `/api/dashboard` surface:
 *   - `assemble(actor, params)` → the caller's FULL role-scoped tile set (GET /api/dashboard). Only the
 *     tiles the role may see are computed; a tile the role may not see is ABSENT from the payload, never
 *     blanked (FR-DSH-010). Tiles are computed concurrently — one slow source does not block the rest.
 *   - `tile(key, actor, params)` → ONE tile, re-read live (GET /api/dashboard/tiles/:key). An unknown key
 *     is 404 (UnknownTileError); a tile the role may not see is 403 (TileNotPermittedError), independent
 *     of project scope (FR-DSH-005/-010).
 * Company (F3) + assigned-projects (F4) scope and the 403-on-unassigned-project rule are resolved by
 * DashboardScopeService (which reuses RPT's ReportScopeService). DSH writes nothing (FR-DSH-003).
 */
import { Injectable } from '@nestjs/common';
import { Actor } from '../../core/tenancy/tenant-context';
import { findTile } from '../domain/tile-catalog';
import { Tile } from '../domain/tile.model';
import { TileNotPermittedError, UnknownTileError } from '../domain/errors';
import { DashboardParams, DashboardScopeService } from './dashboard-scope.service';
import { TileQueryService } from './tile-query.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly scope: DashboardScopeService,
    private readonly tiles: TileQueryService,
  ) {}

  /** The caller's full role-scoped tile set (FR-DSH-005/-007/-010). */
  async assemble(actor: Actor, params: DashboardParams): Promise<Tile<unknown>[]> {
    const visible = this.scope.visibleTiles(actor);
    const tileScope = this.scope.resolve(actor, params); // 403 on unassigned projectId (FR-DSH-009)
    return Promise.all(visible.map((d) => this.tiles.compute(d, tileScope)));
  }

  /** A single tile re-read live (FR-DSH-005); 404 unknown, 403 role may not see it (FR-DSH-010). */
  async tile(key: string, actor: Actor, params: DashboardParams): Promise<Tile<unknown>> {
    const descriptor = findTile(key);
    if (!descriptor) throw new UnknownTileError(key);
    if (!this.scope.canSee(actor, descriptor)) throw new TileNotPermittedError(key);
    const tileScope = this.scope.resolve(actor, params); // 403 on unassigned projectId (FR-DSH-009)
    return this.tiles.compute(descriptor, tileScope);
  }
}
