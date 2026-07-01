/**
 * CC classification policy (FR-CC-011/012/015) — pure, no DB, no Nest. Threshold boundaries and
 * utilisation exactness proven with decimal.js (no float drift). Design §9 "Domain unit" scenarios.
 */
import Decimal from 'decimal.js';
import { classify } from '../../../src/core/cost-control/domain/cost-control.policy';

const D = (v: string | number) => new Decimal(v);

describe('classify() — over-budget policy', () => {
  it('UNBUDGETED when budget is null (utilisation null) (FR-CC-015)', () => {
    expect(classify(null, D(100))).toEqual({ status: 'UNBUDGETED', utilisationPct: null });
  });

  it('UNBUDGETED when budget is zero or negative (FR-CC-015)', () => {
    expect(classify(D(0), D(100)).status).toBe('UNBUDGETED');
    expect(classify(D('-5'), D(100)).status).toBe('UNBUDGETED');
  });

  it('OVER when actual equals budget (100%) (FR-CC-011)', () => {
    const r = classify(D(1000), D(1000));
    expect(r.status).toBe('OVER');
    expect(r.utilisationPct!.toFixed(4)).toBe('100.0000');
  });

  it('APPROACHING at exactly 90% (FR-CC-012)', () => {
    const r = classify(D(1000), D(900));
    expect(r.status).toBe('APPROACHING');
    expect(r.utilisationPct!.toFixed(4)).toBe('90.0000');
  });

  it('OK at 50%', () => {
    const r = classify(D(1000), D(500));
    expect(r.status).toBe('OK');
    expect(r.utilisationPct!.toFixed(4)).toBe('50.0000');
  });

  it('OK below 90% and APPROACHING at/above it (exact boundaries)', () => {
    expect(classify(D(1_000_000), D(899_999)).status).toBe('OK'); // 89.9999%
    expect(classify(D(1_000_000), D(900_000)).status).toBe('APPROACHING'); // 90.0000%
    expect(classify(D(1_000_000), D(999_999)).status).toBe('APPROACHING'); // 99.9999%
    expect(classify(D(1_000_000), D(1_000_000)).status).toBe('OVER'); // 100.0000%
  });

  it('utilisation is exact decimal — 1/3 → 33.3333% with no float drift', () => {
    const r = classify(D(3), D(1));
    expect(r.status).toBe('OK');
    expect(r.utilisationPct!.toFixed(4)).toBe('33.3333');
  });

  it('OVER beyond 100% (e.g. 104.5%)', () => {
    const r = classify(D(1000), D(1045));
    expect(r.status).toBe('OVER');
    expect(r.utilisationPct!.toFixed(4)).toBe('104.5000');
  });
});
