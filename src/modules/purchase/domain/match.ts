/**
 * match.ts (PURE — no NestJS/TypeORM) — the billed-vs-received three-way-match arithmetic (FR-PUR-017,
 * FR-PUR-018). A single place computes the per-line match status and the open (unreceived) quantity from
 * exact Decimals; the read side (poMatch / bill & GRN line DTOs) and the GRN post (recording the line's
 * match_status) both call THESE functions — the status is never stored as a running balance, only computed
 * (or snapshotted on a GRN line at its post from the same function).
 *
 * Phase 1 match is ADVISORY (design §10 Q2, RESOLVED): the status is recorded and exposed, never a
 * hard-block — OVER_RECEIVED does not reject a post (FR-PUR-017; SRS edge case 6).
 */
import Decimal from 'decimal.js';

export type MatchStatus = 'MATCHED' | 'OVER_RECEIVED' | 'UNDER_RECEIVED' | 'PENDING_RECEIPT';
export const MATCH_STATUSES: readonly MatchStatus[] = [
  'MATCHED',
  'OVER_RECEIVED',
  'UNDER_RECEIVED',
  'PENDING_RECEIPT',
] as const;

/**
 * Billed-vs-received → match status (FR-PUR-017):
 *   - nothing received yet                → PENDING_RECEIPT
 *   - received < billed                   → UNDER_RECEIVED
 *   - received = billed (> 0)             → MATCHED
 *   - received > billed (incl. billed 0)  → OVER_RECEIVED (advisory, never blocked — edge case 6)
 * Compared as exact Decimal — never float tolerance.
 */
export function matchStatusOf(billedQty: Decimal, receivedSoFar: Decimal): MatchStatus {
  if (receivedSoFar.isZero()) return 'PENDING_RECEIPT';
  if (receivedSoFar.greaterThan(billedQty)) return 'OVER_RECEIVED';
  if (receivedSoFar.lessThan(billedQty)) return 'UNDER_RECEIVED';
  return 'MATCHED';
}

/**
 * Open (unreceived) quantity per line = billed − Σ received(POSTED GRNs), floored at 0 (FR-PUR-018).
 * An over-receipt does not go negative here — the OVER_RECEIVED status carries the variance; the open
 * balance a later GRN may still receive is simply zero.
 */
export function openQtyOf(billedQty: Decimal, receivedSoFar: Decimal): Decimal {
  const open = billedQty.minus(receivedSoFar);
  return open.isNegative() ? new Decimal(0) : open;
}
