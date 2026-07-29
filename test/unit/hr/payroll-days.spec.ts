/**
 * `computePayrollDays` — the corrected payroll rule (FR-HR-013a, design §8.3). Pure: no DB, no Nest.
 *
 * THE DEFECT THIS PINS. `standardDays` counted CALENDAR days (31 for July) while `paidDays` counted
 * only days carrying an attendance row — and weekly/government holidays have no attendance rows,
 * because they are computed at report time and never stored. So a monthly employee present every
 * single working day was paid 26/31 ≈ 84% of salary.
 *
 * The pure calculator was never wrong: `calcGross` returns full pay for 30/30. The WIRING was wrong.
 * And no test asserted "full working month → full salary", which is precisely why the defect survived
 * review, CI and a Done marker. The first test below is that missing assertion.
 */
import { computePayrollDays, penaltyDays } from '../../../src/modules/hr/domain/payroll-days';

const THRESHOLD = { lateAfterHour: 9, lateAfterMinute: 30 };
const JULY = { periodStart: '2026-07-01', periodEnd: '2026-07-31' };
/** 2026-07-03, -10, -17, -24, -31 are Fridays — the Bangladeshi weekly holiday. */
const HOLIDAYS = new Set(['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31']);

function present(date: string, checkIn: string | null = '09:00:00') {
  return { attendanceDate: date, dayStatus: 'PRESENT', checkIn, projectId: 'p1', overtimeHours: '0' };
}

function statusOnly(date: string, dayStatus: string) {
  return { attendanceDate: date, dayStatus, checkIn: null, projectId: 'p1', overtimeHours: '0' };
}

function allWorkingDaysPresent() {
  const days = [];
  for (let d = 1; d <= 31; d += 1) {
    const date = `2026-07-${String(d).padStart(2, '0')}`;
    if (!HOLIDAYS.has(date)) days.push(present(date));
  }
  return days;
}

function compute(over: Partial<Parameters<typeof computePayrollDays>[0]> = {}) {
  return computePayrollDays({
    ...JULY,
    employmentStart: null,
    employmentEnd: null,
    days: allWorkingDaysPresent(),
    holidayDates: HOLIDAYS,
    lateThreshold: THRESHOLD,
    ...over,
  });
}

describe('computePayrollDays — the full month is the baseline (FR-HR-013a)', () => {
  it('⭐ pays the FULL month when every working day is attended', () => {
    // THE assertion whose absence let the 26/31 defect ship. If this ever goes red, every monthly
    // employee is being underpaid again.
    const r = compute();

    expect(r.standardDays).toBe(31);
    expect(r.workingDays).toBe(26); // 31 calendar − 5 Fridays
    expect(r.unpaidDays).toBe(0);
    expect(r.paidDays).toBe(31);
    expect(r.attendedDays).toBe(26);
  });

  it('never deducts for a holiday, and never lists one as missing', () => {
    // Holidays sit INSIDE the baseline. They have no attendance row and must not be mistaken for a
    // data gap — that mistake is what turned every weekend into an unpaid day.
    const r = compute();

    expect(r.missingDays).toEqual([]);
    expect(r.paidDays).toBe(31);
  });

  it('counts a government holiday coinciding with a weekly holiday only once', () => {
    // The caller merges both sets before calling; a Set makes the collision idempotent by
    // construction, which is the property worth pinning.
    const withCollision = new Set([...HOLIDAYS, '2026-07-03']);
    const r = compute({ holidayDates: withCollision });

    expect(r.standardDays).toBe(31);
    expect(r.workingDays).toBe(26);
  });

  it('deducts a working day marked ABSENT', () => {
    const days = allWorkingDaysPresent().filter((d) => d.attendanceDate !== '2026-07-06');
    days.push(statusOnly('2026-07-06', 'ABSENT'));

    const r = compute({ days });

    expect(r.paidDays).toBe(30);
    expect(r.unpaidDays).toBe(1);
    expect(r.missingDays).toEqual([]); // it HAS a record; it is not a data gap
  });

  it('deducts a working day with NO record and reports it as missing', () => {
    // Absence of data is indistinguishable from absence of the person, so it deducts — which is
    // exactly why it must also be REPORTED. One week of device downtime is one week of lost pay.
    const days = allWorkingDaysPresent().filter((d) => d.attendanceDate !== '2026-07-07');

    const r = compute({ days });

    expect(r.paidDays).toBe(30);
    expect(r.missingDays).toEqual(['2026-07-07']);
  });

  it('treats PAID_LEAVE as paid and UNPAID_LEAVE as unpaid', () => {
    const days = allWorkingDaysPresent().filter(
      (d) => d.attendanceDate !== '2026-07-06' && d.attendanceDate !== '2026-07-07',
    );
    days.push(statusOnly('2026-07-06', 'PAID_LEAVE'));
    days.push(statusOnly('2026-07-07', 'UNPAID_LEAVE'));

    const r = compute({ days });

    expect(r.paidDays).toBe(30); // only the UNPAID_LEAVE day deducts
    expect(r.unpaidDays).toBe(1);
    // Neither is an attended day — a leave day is not worked.
    expect(r.attendedDays).toBe(24);
  });

  it('counts late days against the threshold, and 09:30:59 is still on time', () => {
    const days = allWorkingDaysPresent();
    days[0] = present(days[0]!.attendanceDate, '09:45:00');
    days[1] = present(days[1]!.attendanceDate, '09:30:59'); // the minute must FULLY elapse
    days[2] = present(days[2]!.attendanceDate, '09:31:00');

    const r = compute({ days });

    expect(r.lateDays).toBe(2);
  });

  it('does not count a day with no check-in as late', () => {
    const days = allWorkingDaysPresent();
    days[0] = present(days[0]!.attendanceDate, null);

    expect(compute({ days }).lateDays).toBe(0);
  });

  it('clips standardDays to the employment period for a mid-month joiner', () => {
    // Someone joining on the 20th is charged 0 absences for the 1st–19th, not 19.
    const r = compute({ employmentStart: '2026-07-20', days: [] });

    expect(r.standardDays).toBe(12); // 20th–31st inclusive
    // Of those 12, the 24th and 31st are Fridays.
    expect(r.workingDays).toBe(10);
    expect(r.missingDays).toHaveLength(10);
  });

  it('does not clip for someone employed before the period started', () => {
    expect(compute({ employmentStart: '2020-01-01' }).standardDays).toBe(31);
  });

  it('never clamps to today — a period generated mid-month keeps its full length', () => {
    // Clamping would silently shorten the month and underpay everyone. A payroll period is closed
    // before it is run, so "the future" is not a concept here.
    const farFuture = { periodStart: '2099-07-01', periodEnd: '2099-07-31' };

    expect(compute({ ...farFuture, days: [], holidayDates: new Set() }).standardDays).toBe(31);
  });

  it('ignores rows outside the period rather than counting them', () => {
    const days = [...allWorkingDaysPresent(), present('2026-08-03')];

    expect(compute({ days }).paidDays).toBe(31);
  });
});

describe('penaltyDays — N lates cost one day (FR-HR-013a, FR-HR-008c)', () => {
  it('deducts one day per N lates, never rounding a partial group up', () => {
    expect(penaltyDays(7, 3)).toBe(2);
    expect(penaltyDays(2, 3)).toBe(0);
    expect(penaltyDays(0, 3)).toBe(0);
    expect(penaltyDays(9, 3)).toBe(3);
  });

  it('guards against a zero or negative divisor instead of dividing by it', () => {
    // `lates_per_deducted_day` is CHECKed >= 1 in the schema, but a defaulted or corrupted value
    // must not turn a payroll run into Infinity days of penalty.
    expect(penaltyDays(7, 0)).toBe(7);
    expect(penaltyDays(7, -3)).toBe(7);
  });
});
