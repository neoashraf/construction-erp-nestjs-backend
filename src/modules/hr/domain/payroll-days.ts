/**
 * payroll-days (PURE — no NestJS, no TypeORM, no DB). Turns one employee's OFFICE attendance rows into
 * the day counts the salary calculator needs (FR-HR-013a, design §8.3).
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────────────
 * The full month is the paid BASELINE and you deduct from it. You do not build up to it.
 *
 *   standardDays = calendar days in the period (clipped to the employment period)
 *   workingDays  = standardDays − weekly holidays − government holidays
 *   unpaidDays   = working days ABSENT or UNPAID_LEAVE, PLUS working days with NO record at all
 *   paidDays     = standardDays − unpaidDays
 *
 * The previous implementation built UP from days that happened to carry an attendance row, against a
 * calendar-day divisor. Weekly and government holidays are computed at report time and never stored,
 * so they had no rows — and every monthly employee was docked for every weekend. Present on all 26
 * working days of a 31-day July paid 26/31 ≈ 84%.
 *
 * ── WHY A MISSING RECORD DEDUCTS ──────────────────────────────────────────────────────────────────
 * Absence of data is indistinguishable from absence of the person. That is the correct rule, and it
 * is also dangerous: one week of device downtime silently removes a week's pay from every head-office
 * employee, and the first person to notice is the employee. Hence `missingDays` — the caller MUST
 * surface it before posting (FR-HR-013a's pre-post warning). Returning the count alone would not be
 * enough to tell a data gap from genuine absence.
 *
 * ── WHY NO CLAMP TO TODAY ─────────────────────────────────────────────────────────────────────────
 * `listDatesInclusive` clamps to today for REPORTS, so a half-elapsed month does not invent absences
 * on days that have not happened. Payroll is the opposite case: a period is closed before it is run,
 * and clamping would silently shorten the month and underpay everyone. This module never clamps.
 */
import { isLateCheckIn, startOfLocalDate } from '../attendance-reports/domain/attendance-rules';

/** One OFFICE `attendance_record` row, projected to just what the day counts need. */
export interface OfficeDayRow {
  attendanceDate: string; // 'YYYY-MM-DD'
  dayStatus: string | null; // PRESENT | PAID_LEAVE | UNPAID_LEAVE | ABSENT
  checkIn: string | null; // 'HH:mm:ss'
  projectId: string;
  overtimeHours: string;
}

export interface PayrollDays {
  /** The paid baseline: calendar days in the period, clipped to the employment period. */
  standardDays: number;
  /** `standardDays` minus holidays — the days an employee was actually expected to work. */
  workingDays: number;
  unpaidDays: number;
  /** `standardDays − unpaidDays`. Holidays are inside this; they are paid. */
  paidDays: number;
  lateDays: number;
  /** Days actually worked — the DAILY wage type's basis, and never a leave day. */
  attendedDays: number;
  /** Working days with no record at all. The pre-post data-gap warning reads this. */
  missingDays: string[];
}

export interface PayrollDaysInput {
  periodStart: string;
  periodEnd: string;
  /** The employee's joining date; days before it are not chargeable. */
  employmentStart: string | null;
  /**
   * Always `null` today. `Employee` has no exit date — a leaver is INACTIVE and `activeForCompany`
   * already excludes them from generation (FR-HR-003) — so there is no end bound to clip against.
   * The parameter exists because the day a leaving date is modelled, this is where it belongs.
   */
  employmentEnd: string | null;
  days: readonly OfficeDayRow[];
  /** Weekly + government holidays, already merged. A Set makes a collision count once, by design. */
  holidayDates: ReadonlySet<string>;
  lateThreshold: { lateAfterHour: number; lateAfterMinute: number };
}

/** Statuses that cost the employee a day's pay. `PAID_LEAVE` is deliberately not one of them. */
const UNPAID_STATUSES = new Set(['ABSENT', 'UNPAID_LEAVE']);

/**
 * Every date from `start` to `end` inclusive — WITHOUT the report layer's clamp to today.
 *
 * Deliberately not `listDatesInclusive`: that helper clamps, and passing it a far-future sentinel to
 * defeat the clamp would make the no-clamp guarantee depend on a magic number rather than on the code
 * saying what it means.
 */
function eachDate(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = startOfLocalDate(start);
  const last = startOfLocalDate(end);

  while (current <= last) {
    dates.push(
      `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(
        current.getDate(),
      ).padStart(2, '0')}`,
    );
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

export function computePayrollDays(input: PayrollDaysInput): PayrollDays {
  const inEmployment = (date: string): boolean =>
    (!input.employmentStart ||
      startOfLocalDate(date) >= startOfLocalDate(input.employmentStart)) &&
    (!input.employmentEnd || startOfLocalDate(date) <= startOfLocalDate(input.employmentEnd));

  const dates = eachDate(input.periodStart, input.periodEnd).filter(inEmployment);
  const byDate = new Map(input.days.map((day) => [day.attendanceDate, day]));

  let workingDays = 0;
  let unpaidDays = 0;
  let lateDays = 0;
  let attendedDays = 0;
  const missingDays: string[] = [];

  for (const date of dates) {
    // Holidays are paid and are never chargeable — they are inside the baseline, not added to it.
    if (input.holidayDates.has(date)) continue;
    workingDays += 1;

    const row = byDate.get(date);
    if (!row) {
      unpaidDays += 1;
      missingDays.push(date);
      continue;
    }

    if (UNPAID_STATUSES.has(row.dayStatus ?? '')) {
      unpaidDays += 1;
      continue;
    }

    // PRESENT (or a row with times and no status, which reconciliation also creates).
    if (row.dayStatus === null || row.dayStatus === 'PRESENT') {
      attendedDays += 1;
      if (row.checkIn && isLate(row.checkIn, input.lateThreshold)) lateDays += 1;
    }
  }

  const standardDays = dates.length;

  return {
    standardDays,
    workingDays,
    unpaidDays,
    paidDays: standardDays - unpaidDays,
    lateDays,
    attendedDays,
    missingDays,
  };
}

/**
 * `floor(lateDays / latesPerDeductedDay)` — a partial group NEVER rounds up.
 *
 * The divisor is CHECKed `>= 1` in the schema, but a defaulted or corrupted value must not turn a
 * payroll run into `Infinity` days of penalty, so it is floored at 1 here too.
 */
export function penaltyDays(lateDays: number, latesPerDeductedDay: number): number {
  return Math.floor(lateDays / Math.max(1, latesPerDeductedDay));
}

/** `'HH:mm:ss'` against the configured cut-off. The threshold minute must fully elapse (FR-HR-008c). */
function isLate(checkIn: string, threshold: { lateAfterHour: number; lateAfterMinute: number }): boolean {
  const [hour, minute, second] = checkIn.split(':').map(Number);
  // An arbitrary date: only the time-of-day matters, and `isLateCheckIn` reads hours/minutes only.
  const at = new Date(2000, 0, 1, hour ?? 0, minute ?? 0, second ?? 0);
  return isLateCheckIn(at, threshold);
}
