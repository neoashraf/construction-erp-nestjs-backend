/**
 * Monthly period-generation unit tests (no DB) — 12 contiguous, inclusive, non-overlapping months
 * spanning a Jul–Jun FY (FR-PER-002/003).
 */
import { monthlyPeriods } from '../../../src/core/period/domain/period-generation';

describe('monthlyPeriods', () => {
  it('splits a Jul 2025 – Jun 2026 FY into 12 contiguous months', () => {
    const spans = monthlyPeriods('2025-07-01', '2026-06-30');
    expect(spans).toHaveLength(12);
    expect(spans[0]).toEqual({ name: 'Jul 2025', startDate: '2025-07-01', endDate: '2025-07-31' });
    expect(spans[1]).toEqual({ name: 'Aug 2025', startDate: '2025-08-01', endDate: '2025-08-31' });
    expect(spans[7]).toEqual({ name: 'Feb 2026', startDate: '2026-02-01', endDate: '2026-02-28' });
    expect(spans[11]).toEqual({ name: 'Jun 2026', startDate: '2026-06-01', endDate: '2026-06-30' });
  });

  it('is contiguous and non-overlapping (each start is the day after the previous end)', () => {
    const spans = monthlyPeriods('2025-07-01', '2026-06-30');
    for (let i = 1; i < spans.length; i++) {
      const prevEnd = new Date(`${spans[i - 1].endDate}T00:00:00Z`);
      const thisStart = new Date(`${spans[i].startDate}T00:00:00Z`);
      expect(thisStart.getTime() - prevEnd.getTime()).toBe(24 * 3600 * 1000);
    }
  });

  it('clamps the last span to the FY end for a non-month-aligned range', () => {
    const spans = monthlyPeriods('2025-07-01', '2025-09-15');
    expect(spans).toHaveLength(3);
    expect(spans[2]).toEqual({ name: 'Sep 2025', startDate: '2025-09-01', endDate: '2025-09-15' });
  });
});
