/**
 * TileDescriptor + catalog types (DSH · FR-DSH-001/-002/-004/-007/-010) — PURE domain (no Nest, no
 * TypeORM). A descriptor is one catalog entry: the tile's `key` (its stable payload id and the
 * `…/tiles/:key` path segment), the owning read `source` it summarises (LEDGER / COST_CONTROL /
 * SALES_IPC / INVENTORY / HR — never a second definition of a figure, FR-DSH-004), its `drillToReport`
 * (a REGISTERED RPT report name the tile navigates into, FR-DSH-002), the `requiredPermission` gating it
 * (aligned with the drill-down report's RPT permission, FR-DSH-010), whether its figures are filtered to
 * a project-scoped user's assigned projects (FR-DSH-008), and the `roles` that see it (overview §2,
 * FR-DSH-007). DSH owns no entity, no migration, and never writes the ledger — a descriptor is code.
 */

/** The owning read source a tile summarises (mirrors RPT's read-port families). */
export type TileSource = 'LEDGER' | 'COST_CONTROL' | 'SALES_IPC' | 'INVENTORY' | 'HR';

export interface TileDescriptor {
  /** Stable tile key / path segment, e.g. 'over-budget', 'pending-ipcs'. Unique across the catalog. */
  key: string;
  /** Human-readable, Bangla-safe title. */
  title: string;
  /** The owning read port the tile summarises (FR-DSH-004) — never a second definition of a figure. */
  source: TileSource;
  /** The RPT report name the tile drills into (FR-DSH-002) — always a registered RPT report. */
  drillToReport: string;
  /** The permission gating the tile, aligned with the drill-down report's RPT permission (FR-DSH-010). */
  requiredPermission: string;
  /** Figures filtered to assigned projects for project-scoped users (FR-DSH-008). */
  projectScoped: boolean;
  /** The roles that see this tile (overview §2) — drives role-scoped assembly (FR-DSH-007). */
  roles: string[];
}
