/**
 * Monthly period generation (PURE). Splits an FY `[startDate, endDate]` into contiguous, inclusive,
 * non-overlapping monthly spans — one per calendar month, the first clamped to the FY start and the
 * last to the FY end (FR-PER-002/003, design §10 monthly cadence). Calendar math via UTC Date.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface MonthlySpan {
  name: string; // e.g. "Jul 2025"
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function monthlyPeriods(fyStart: string, fyEnd: string): MonthlySpan[] {
  const spans: MonthlySpan[] = [];
  const [sy, sm, sd] = fyStart.split('-').map((n) => parseInt(n, 10));
  let year = sy;
  let month = sm; // 1-based
  let cursorStart = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(`${fyEnd}T00:00:00Z`);

  while (cursorStart.getTime() <= end.getTime()) {
    const monthEnd = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
    const spanEnd = monthEnd.getTime() <= end.getTime() ? monthEnd : end;
    spans.push({
      name: `${MONTHS[month - 1]} ${year}`,
      startDate: iso(cursorStart),
      endDate: iso(spanEnd),
    });
    // advance to the first day of the next month
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    cursorStart = new Date(Date.UTC(year, month - 1, 1));
  }
  return spans;
}
