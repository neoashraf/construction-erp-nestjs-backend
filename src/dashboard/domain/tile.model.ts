/**
 * Tile<Kpi> + the per-tile KPI shapes (DSH · SRS §8) — PURE domain DTOs, NOT tables. DSH owns no
 * persistent entity and stores no tile value (Phase 1); a tile is a pure query result computed at read
 * time. Money is `Decimal(18,4)` serialised as decimal strings (e.g. '375000.0000') — never float
 * (overview §8); counts are integers. Each KPI is a summary of its owning source (CC / SAL / INV / HR /
 * LED via RPT), never a parallel computation (FR-DSH-004).
 */

/** A tile's status classification — the SOURCE's classification rendered, never one DSH invents (FR-DSH-018). */
export type TileStatus = 'OK' | 'APPROACHING' | 'OVER' | 'BREACH';

/** The drill-down reference — a registered RPT report name + the params the UI navigates with (FR-DSH-002). */
export interface DrillTo {
  report: string;
  params: Record<string, unknown>;
}

/** The generic tile envelope (SRS §8 Tile<Kpi>). `kpi` is one of the shapes below. */
export interface Tile<Kpi> {
  /** The catalog key that produced this tile. */
  key: string;
  /** The tile title. */
  title: string;
  /** The headline value(s) — one of the KPI shapes below. */
  kpi: Kpi;
  /** The source's classification where it has one; null where purely numeric (FR-DSH-018). */
  status: TileStatus | null;
  /** `{ report, params }` — the RPT report + params the UI navigates with (FR-DSH-002). */
  drillTo: DrillTo;
  /** When the tile's source was read (ISO-8601 UTC). */
  generatedAt: string;
}

/** project-cash-flow KPI — over LED cash/bank lines (FR-DSH-011). */
export interface CashFlowKpi {
  /** Σ receipts − Σ payments through cash + bank accounts for the window (LED). */
  netInflow: string;
  /** Current cash control-account balance (LED). */
  cashBalance: string;
  /** Current bank control-account balance (LED). */
  bankBalance: string;
}

/** pending-ipcs KPI — over SAL per-IPC outstanding (FR-DSH-012). */
export interface PendingIpcKpi {
  /** Number of posted IPCs with outstanding > 0 for the scope (SAL FR-SAL-016). */
  count: number;
  /** Σ per-IPC outstanding for those IPCs (SAL) — RPT's IPC report total. */
  totalOutstanding: string;
}

/** retention-held KPI — over SAL retention held (FR-DSH-013). */
export interface RetentionHeldKpi {
  /** Σ (retention withheld − released) across the scope's IPCs (SAL FR-SAL-019). */
  totalRetentionHeld: string;
}

/** low-stock KPI — over INV stock ledger via RPT low-stock (FR-DSH-014). */
export interface LowStockKpi {
  /** Number of (godown, item) rows at or below re-order level (RPT FR-RPT-022; INV FR-INV-004). */
  count: number;
}

/** over-budget KPI — over CC current alerts (FR-DSH-015). */
export interface OverBudgetKpi {
  /** Number of (project, cost centre) pairs currently OVER (CC FR-CC-016). */
  overCount: number;
  /** Number currently APPROACHING (CC). */
  approachingCount: number;
}

/** attendance-summary KPI — over HR attendance roll-up via RPT (FR-DSH-016). */
export interface AttendanceKpi {
  /** The current period ('YYYY-MM') summarised. */
  period: string;
  /** Σ present days for the scope (HR FR-HR-004). */
  presentDays: number;
  /** Σ daily-labour + subcontractor head counts for the scope (HR FR-HR-005/-006). */
  headCountTotal: string;
}

/** A party-outstanding row on the top-receivables / top-payables lists. */
export interface PartyOutstandingRow {
  partyId: string;
  partyName: string;
  outstanding: string;
}

/** top-receivables-payables KPI — over LED AR/AP by party (FR-DSH-017). */
export interface TopReceivablePayableKpi {
  /** Top-N parties by AR outstanding. */
  topReceivables: PartyOutstandingRow[];
  /** Top-N parties by AP outstanding. */
  topPayables: PartyOutstandingRow[];
}
