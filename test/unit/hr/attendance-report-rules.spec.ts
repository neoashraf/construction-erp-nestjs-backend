/**
 * Pure attendance-report rule tests (no DB, no Nest) — the verification table in
 * REPORTS_MODULE_GUIDE §9: calendar validation, the late-threshold boundary, holiday precedence, range
 * labels, CSV escaping, and the Excel text-literal trick.
 */
import {
  STATUS,
  assertDateText,
  buildHolidayInfoMap,
  buildRangeLabel,
  buildWeeklyHolidayDateSet,
  compareUserIds,
  escapeCsvValue,
  formatExcelText,
  formatLocalTime,
  getWeekday,
  countDaysInclusive,
  listDatesInclusive,
  resolveAttendanceStatus,
  toCsv,
} from '../../../src/modules/hr/attendance-reports/domain/attendance-rules';

const NINE_THIRTY = { lateAfterHour: 9, lateAfterMinute: 30 };

describe('assertDateText', () => {
  it('accepts a well-formed date', () => {
    expect(assertDateText('2026-07-26', 'date')).toBe('2026-07-26');
  });

  it('rejects a malformed date with the contracted message', () => {
    expect(() => assertDateText('26/07/2026', 'date')).toThrow('date must be in YYYY-MM-DD format');
  });

  it('rejects an impossible calendar day the regex would accept', () => {
    expect(() => assertDateText('2026-02-31', 'date')).toThrow('date is not a valid calendar date');
  });
});

describe('late threshold (§3.4)', () => {
  it('treats the last second of the threshold minute as on time', () => {
    expect(resolveAttendanceStatus('2026-07-26 09:30:59', NINE_THIRTY)).toBe(STATUS.PRESENT);
  });

  it('treats the first second after the threshold minute as late', () => {
    expect(resolveAttendanceStatus('2026-07-26 09:31:00', NINE_THIRTY)).toBe(STATUS.LATE);
  });

  it('marks a day with no check-in absent', () => {
    expect(resolveAttendanceStatus(null, NINE_THIRTY)).toBe(STATUS.ABSENT);
  });
});

describe('holiday precedence (§3.3)', () => {
  const dates = listDatesInclusive('2026-07-01', '2026-07-07');

  it('marks the configured weekday as a weekly holiday', () => {
    const weekly = buildWeeklyHolidayDateSet(dates, [getWeekday('2026-07-03')]);
    const info = buildHolidayInfoMap(weekly, new Map());

    expect(info.get('2026-07-03')).toEqual({ name: 'Weekly Holiday', type: 'weekly' });
  });

  it('lets a government holiday override a weekly one and prefer the local name', () => {
    const weekly = buildWeeklyHolidayDateSet(dates, [getWeekday('2026-07-03')]);
    const government = new Map([
      ['2026-07-03', { date: '2026-07-03', name: 'Eid ul-Fitr', localName: 'ঈদুল ফিতর' }],
    ]);
    const info = buildHolidayInfoMap(weekly, government);

    expect(info.get('2026-07-03')).toEqual({ name: 'ঈদুল ফিতর', type: 'government' });
  });

  it('falls back to the English name when there is no local name', () => {
    const government = new Map([
      ['2026-07-03', { date: '2026-07-03', name: 'Victory Day', localName: null }],
    ]);
    const info = buildHolidayInfoMap(new Set(), government);

    expect(info.get('2026-07-03')).toEqual({ name: 'Victory Day', type: 'government' });
  });
});

describe('listDatesInclusive', () => {
  it('includes both ends and spans month boundaries', () => {
    expect(listDatesInclusive('2026-06-29', '2026-07-02', new Date(2026, 6, 31))).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
    ]);
  });

  it('CLAMPS the end to today — future days are not working days', () => {
    // A "July" filter on the 27th must measure 27 days, not 31. Counting the 4 remaining
    // days would invent an absence per employee per day and sink every percentage.
    const dates = listDatesInclusive('2026-07-01', '2026-07-31', new Date(2026, 6, 27));
    expect(dates).toHaveLength(27);
    expect(dates[dates.length - 1]).toBe('2026-07-27');
  });

  it('includes today itself', () => {
    const dates = listDatesInclusive('2026-07-25', '2026-07-31', new Date(2026, 6, 27));
    expect(dates).toEqual(['2026-07-25', '2026-07-26', '2026-07-27']);
  });

  it('ignores the clamp for a window entirely in the past', () => {
    expect(listDatesInclusive('2026-06-01', '2026-06-03', new Date(2026, 6, 27))).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ]);
  });

  it('returns nothing for a window entirely in the future', () => {
    expect(listDatesInclusive('2027-01-01', '2027-01-31', new Date(2026, 6, 27))).toEqual([]);
  });

  it('is unaffected by the time of day on `today`', () => {
    // A late-evening `new Date()` must not let tomorrow slip in.
    const lateToday = new Date(2026, 6, 27, 23, 59, 59);
    const dates = listDatesInclusive('2026-07-26', '2026-07-31', lateToday);
    expect(dates[dates.length - 1]).toBe('2026-07-27');
  });
});

describe('countDaysInclusive', () => {
  it('measures the REQUESTED span, ignoring the today-clamp', () => {
    // Range-limit validation must judge what was asked for; otherwise a far-future window
    // measures as 0 days and slips past the 366-day guard.
    expect(countDaysInclusive('2027-01-01', '2027-12-31')).toBe(365);
    expect(countDaysInclusive('2026-07-01', '2026-07-31')).toBe(31);
  });

  it('counts a single day as one and a reversed range as zero', () => {
    expect(countDaysInclusive('2026-07-01', '2026-07-01')).toBe(1);
    expect(countDaysInclusive('2026-07-31', '2026-07-01')).toBe(0);
  });
});

describe('buildRangeLabel', () => {
  it('names the month when the range is exactly one whole month', () => {
    expect(buildRangeLabel('2026-07-01', '2026-07-31')).toBe('July 2026');
  });

  // NOTE: the day is NOT zero-padded — `parseDateParts` yields a Number, so the 1st renders as "1 Jul".
  // The guide's §4.3 sample body shows "01 Jul 2026"; its source (`attendanceRules.js`
  // `formatDisplayDate`), which the guide names as the source of truth, produces "1 Jul 2026". The code
  // wins, so the label here is byte-identical to what the Express service actually returns.
  it('renders a span for a partial month', () => {
    expect(buildRangeLabel('2026-07-01', '2026-07-26')).toBe('1 Jul 2026 - 26 Jul 2026');
  });

  it('renders a single day as one date', () => {
    expect(buildRangeLabel('2026-07-26', '2026-07-26')).toBe('26 Jul 2026');
  });
});

describe('compareUserIds', () => {
  it('orders numeric codes numerically, not lexicographically', () => {
    expect(['10', '9', '100'].sort(compareUserIds)).toEqual(['9', '10', '100']);
  });

  it('falls back to a natural comparison for non-numeric codes', () => {
    expect(['EMP-10', 'EMP-9'].sort(compareUserIds)).toEqual(['EMP-9', 'EMP-10']);
  });
});

describe('formatLocalTime', () => {
  it('renders a device timestamp as 12-hour display time', () => {
    expect(formatLocalTime('2026-07-26 18:03:51')).toBe('6:03:51 PM');
  });

  it('renders midnight as 12 AM', () => {
    expect(formatLocalTime('2026-07-26 00:07:05')).toBe('12:07:05 AM');
  });

  it('returns an empty string when there is no timestamp', () => {
    expect(formatLocalTime(null)).toBe('');
  });
});

describe('CSV output (§5.2, §5.6)', () => {
  it('wraps a date so Excel keeps it as literal text', () => {
    expect(formatExcelText('2026-06-01')).toBe('="2026-06-01"');
  });

  it('leaves an empty value as a genuinely empty cell, not an ="" formula', () => {
    expect(formatExcelText('')).toBe('');
  });

  it('quotes values containing a comma, quote or newline and doubles inner quotes', () => {
    expect(escapeCsvValue('Rahman, Karim')).toBe('"Rahman, Karim"');
    expect(escapeCsvValue('He said "hi"')).toBe('"He said ""hi"""');
    expect(escapeCsvValue('plain')).toBe('plain');
  });

  it('joins rows with CRLF for Excel', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d');
  });
});
