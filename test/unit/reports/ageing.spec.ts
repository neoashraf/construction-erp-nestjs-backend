/**
 * Ageing bucketing (RPT #32 · FR-RPT-017). Pure boundary tests: each boundary day buckets EXACTLY
 * (30→CURRENT, 31→D31_60, 60→D31_60, 61→D61_90, 90→D61_90, 91→D90_PLUS). The bucket is a display
 * classification derived from the due date + as-of; the outstanding total is SAL's, not recomputed here.
 */
import { ageingBucket, daysOverdue } from '../../../src/reports/domain/ageing';

/** As-of = dueDate + `days` (UTC), so daysOverdue === days exactly. */
function asOfPlus(dueDate: string, days: number): string {
  const [y, m, d] = dueDate.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

describe('ageing bucketing (FR-RPT-017)', () => {
  const DUE = '2026-06-30';

  it('daysOverdue counts whole days from due date to as-of (negative when not yet due)', () => {
    expect(daysOverdue(DUE, asOfPlus(DUE, 0))).toBe(0);
    expect(daysOverdue(DUE, asOfPlus(DUE, 45))).toBe(45);
    expect(daysOverdue(DUE, asOfPlus(DUE, -10))).toBe(-10);
  });

  it.each([
    [0, 'CURRENT'],
    [30, 'CURRENT'],
    [31, 'D31_60'],
    [60, 'D31_60'],
    [61, 'D61_90'],
    [90, 'D61_90'],
    [91, 'D90_PLUS'],
    [200, 'D90_PLUS'],
  ])('day %i overdue → %s (boundary buckets exactly)', (days, bucket) => {
    expect(ageingBucket(DUE, asOfPlus(DUE, days as number))).toBe(bucket);
  });

  it('not-yet-due (negative overdue) → CURRENT', () => {
    expect(ageingBucket(DUE, asOfPlus(DUE, -5))).toBe('CURRENT');
  });

  it('an unparsable date degrades to CURRENT rather than throwing (read path)', () => {
    expect(ageingBucket('not-a-date', DUE)).toBe('CURRENT');
    expect(daysOverdue('not-a-date', DUE)).toBe(0);
  });
});
