/**
 * match.ts unit tests (pure — no DB, no Nest). Cites FR-PUR-017 (match status) + FR-PUR-018 (partial
 * receipt / open quantity). Covers all four statuses (AC2), the partial-receipt open-quantity math incl.
 * the 60+40=100 case (AC3), and over-delivery (AC6) — exact Decimal, no float tolerance. 100% on match.ts.
 */
import Decimal from 'decimal.js';
import { matchStatusOf, openQtyOf, MATCH_STATUSES } from '../../../src/modules/purchase/domain/match';

const d = (v: string | number) => new Decimal(v);

describe('matchStatusOf (FR-PUR-017, AC2)', () => {
  it('received < billed -> UNDER_RECEIVED (the 90-of-100 case)', () => {
    expect(matchStatusOf(d(100), d(90))).toBe('UNDER_RECEIVED');
  });

  it('received = billed -> MATCHED', () => {
    expect(matchStatusOf(d(100), d(100))).toBe('MATCHED');
  });

  it('received > billed -> OVER_RECEIVED (the 110-of-100 over-delivery, AC6 — a status, never a block)', () => {
    expect(matchStatusOf(d(100), d(110))).toBe('OVER_RECEIVED');
  });

  it('nothing received yet -> PENDING_RECEIPT (incl. a PO line not yet billed: billed 0, received 0)', () => {
    expect(matchStatusOf(d(100), d(0))).toBe('PENDING_RECEIPT');
    expect(matchStatusOf(d(0), d(0))).toBe('PENDING_RECEIPT');
  });

  it('received > 0 against billed 0 -> OVER_RECEIVED (goods received, nothing billed yet — advisory)', () => {
    expect(matchStatusOf(d(0), d(5))).toBe('OVER_RECEIVED');
  });

  it('compares as exact Decimal — a 0.0001 shortfall is UNDER_RECEIVED, not float-tolerant MATCHED', () => {
    expect(matchStatusOf(d('100.0000'), d('99.9999'))).toBe('UNDER_RECEIVED');
    expect(matchStatusOf(d('100.0000'), d('100.0000'))).toBe('MATCHED');
    expect(matchStatusOf(d('100.0000'), d('100.0001'))).toBe('OVER_RECEIVED');
  });

  it('the value set is exactly the four canonical statuses', () => {
    expect(MATCH_STATUSES).toEqual(['MATCHED', 'OVER_RECEIVED', 'UNDER_RECEIVED', 'PENDING_RECEIPT']);
  });
});

describe('openQtyOf (FR-PUR-018, AC3)', () => {
  it('open = billed - Σ received: 100 billed, 90 received -> 10 open', () => {
    expect(openQtyOf(d(100), d(90)).toFixed(4)).toBe('10.0000');
  });

  it('two partial GRNs 60 then 40 sum to 100 -> open 0 and MATCHED (the AC3 case)', () => {
    const afterFirst = openQtyOf(d(100), d(60));
    expect(afterFirst.toFixed(4)).toBe('40.0000');
    const total = d(60).plus(d(40));
    expect(openQtyOf(d(100), total).toFixed(4)).toBe('0.0000');
    expect(matchStatusOf(d(100), total)).toBe('MATCHED');
  });

  it('nothing received -> the full billed quantity is open', () => {
    expect(openQtyOf(d(100), d(0)).toFixed(4)).toBe('100.0000');
  });

  it('over-receipt floors at 0 (never negative) — OVER_RECEIVED carries the variance', () => {
    expect(openQtyOf(d(100), d(110)).toFixed(4)).toBe('0.0000');
  });

  it('exact decimal arithmetic on fractional quantities', () => {
    expect(openQtyOf(d('2.5000'), d('1.2500')).toFixed(4)).toBe('1.2500');
  });
});
