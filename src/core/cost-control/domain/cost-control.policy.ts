/**
 * CostControlPolicy — the pure over-budget classification (CC domain, FR-CC-011/012/015).
 * PURE TypeScript: no NestJS, no TypeORM, no I/O. `classify(budgeted, actual)` turns a budget and an
 * actual cost into a {status, utilisationPct}. Thresholds are Phase-1 fixed (SRS §15): APPROACHING at
 * ≥ 90 % & < 100 %, OVER at ≥ 100 %, UNBUDGETED when there is no positive budget. Utilisation is an
 * exact decimal ratio (decimal.js, 4 dp) — never floating point (overview §8 decision 10).
 */
import Decimal from 'decimal.js';

export type CostControlStatus = 'OK' | 'APPROACHING' | 'OVER' | 'UNBUDGETED';

export const APPROACHING_THRESHOLD_PCT = new Decimal(90); // Phase-1 fixed (SRS §15)
export const OVER_THRESHOLD_PCT = new Decimal(100);

/** Serialisation scale for the utilisation percentage (matches money's 4 dp — api-contract §12). */
export const UTILISATION_SCALE = 4;

export interface Classification {
  status: CostControlStatus;
  /** Percent utilisation as an exact Decimal, or null when UNBUDGETED. */
  utilisationPct: Decimal | null;
}

/**
 * Classify an actual cost against a budget (FR-CC-011/012/015).
 * - `budgeted` null or ≤ 0 → `UNBUDGETED` (no division, utilisation null).
 * - utilisation = actual / budgeted · 100 (exact decimal).
 * - ≥ 100 % → `OVER`; ≥ 90 % & < 100 % → `APPROACHING`; otherwise `OK`.
 */
export function classify(budgeted: Decimal | null, actual: Decimal): Classification {
  if (budgeted === null || budgeted.lte(0)) {
    return { status: 'UNBUDGETED', utilisationPct: null };
  }
  const utilisationPct = actual.div(budgeted).mul(100);
  if (utilisationPct.gte(OVER_THRESHOLD_PCT)) {
    return { status: 'OVER', utilisationPct };
  }
  if (utilisationPct.gte(APPROACHING_THRESHOLD_PCT)) {
    return { status: 'APPROACHING', utilisationPct };
  }
  return { status: 'OK', utilisationPct };
}
