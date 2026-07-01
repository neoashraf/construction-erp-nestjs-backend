/**
 * StockJournalMode — TRANSFER | ISSUE | ADJUSTMENT + the per-mode side-presence rules (design §2.1,
 * SRS §4 "Stock Journal mode"). PURE TypeScript. Mode determines which godown side(s) a Stock Journal
 * carries and whether posting produces a ledger consumption entry:
 *   - TRANSFER    — both from_godown and to_godown required; from !== to (FR-INV-008, edge 2).
 *   - ISSUE       — from_godown required; to_godown must be absent (a consumption/issue to a cost centre).
 *   - ADJUSTMENT  — exactly one side present (either from OR to, never both) — a single-sided correction
 *                   to a (godown, item) balance (SRS §12 edge 14). Phase 1 supports this shape only; the
 *                   posting/authorisation-gating for ADJUSTMENT beyond side-presence is out of this
 *                   brief's scope (full cycle-count is deferred — SRS §16).
 */
export const STOCK_JOURNAL_MODES = ['TRANSFER', 'ISSUE', 'ADJUSTMENT'] as const;
export type StockJournalMode = (typeof STOCK_JOURNAL_MODES)[number];

/** The godown-side shape a mode requires, expressed as which of from/to must be present/absent. */
export interface ModeSideRule {
  fromRequired: boolean;
  toRequired: boolean;
  toForbidden: boolean;
}

const MODE_RULES: Record<StockJournalMode, ModeSideRule> = {
  TRANSFER: { fromRequired: true, toRequired: true, toForbidden: false },
  ISSUE: { fromRequired: true, toRequired: false, toForbidden: true },
  ADJUSTMENT: { fromRequired: false, toRequired: false, toForbidden: false },
};

export function sideRuleFor(mode: StockJournalMode): ModeSideRule {
  return MODE_RULES[mode];
}
