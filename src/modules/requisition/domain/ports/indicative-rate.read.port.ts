/**
 * IndicativeRateReadPort (driven; owner INV). The rate used ONLY for the requisition ESTIMATE (tiering +
 * the advisory over-budget check) — the item's current weighted-average rate in the source godown, or its
 * last-known rate when the godown holds none (FR-REQ-005, edge 14). It is NOT the posted value (that is
 * INV's at-issue average, computed by brief 2). PURE interface — the INV-reading adapter implements it.
 */
import Decimal from 'decimal.js';

export interface IndicativeRateReadPort {
  /** Current average for (godownId, itemId), else the item's last-known rate, else 0. */
  currentAvgOrLastKnown(companyId: string, godownId: string | null, itemId: string): Promise<Decimal>;
}

export const INDICATIVE_RATE_READ_PORT = Symbol('IndicativeRateReadPort');
