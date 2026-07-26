/**
 * attendance-rules — PURE helpers for the `/api/reports/{daily,range,summary}` attendance reports
 * (REPORTS_MODULE_GUIDE §6.1). No NestJS, no TypeORM, no DB: window resolution, holiday precedence, the
 * late threshold, CSV escaping and the Excel text-literal trick all live here so the whole contract is
 * unit-testable without a database.
 *
 * PORT NOTE (vs the source Express project): that project stored punch-level rows in `CheckinLog` with a
 * TEXT `deviceTimestamp`, so it needed `dayBoundsForRange()` / `getDeviceTimestampDayKey()` to slice dates
 * out of text. Here the punches come from HR's `attendance_record` (mode = OFFICE), which already carries a
 * real `date` column plus `check_in` / `check_out` `time` columns — the read adapter composes the same
 * `'YYYY-MM-DD HH:mm:ss'` string in SQL and filters on the `date` column directly. Those two text-slicing
 * helpers are therefore intentionally absent; every other helper is a line-for-line port and the observable
 * behaviour (statuses, counts, labels, CSV bytes) is identical.
 */

const DEVICE_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2}):(\d{2})$/;

export const DATE_TEXT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const STATUS = {
  PRESENT: 'Present',
  LATE: 'Late',
  ABSENT: 'Absent',
  HOLIDAY: 'Holiday',
} as const;

export type AttendanceReportStatus = (typeof STATUS)[keyof typeof STATUS];

export type HolidayType = 'weekly' | 'government';

export interface HolidayInfo {
  name: string;
  type: HolidayType;
}

/** A government-holiday row as the read adapter returns it. */
export interface GovernmentHoliday {
  date: string;
  name: string;
  localName: string | null;
}

/** The configured late cut-off (`attendance_setting`). */
export interface LateThreshold {
  lateAfterHour: number;
  lateAfterMinute: number;
}

/**
 * A 400 that carries the guide's flat `{ "error": "<message>" }` body. Thrown by the pure validators so
 * the service layer stays free of HTTP concerns; `AttendanceReportExceptionFilter` renders it.
 */
export class ReportBadRequestError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ReportBadRequestError';
  }
}

export function badRequest(message: string): ReportBadRequestError {
  return new ReportBadRequestError(message);
}

/** Numeric-aware employee-code ordering, so `9` sorts before `10` rather than after it. */
export function compareUserIds(a: string, b: string): number {
  const aNumber = Number(a);
  const bNumber = Number(b);

  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber;
  }

  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function formatLocalDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function parseDateParts(dateText: string): { year: number; month: number; day: number } {
  const [year, month, day] = String(dateText).split('-').map(Number);
  return { year: year as number, month: month as number, day: day as number };
}

export function startOfLocalDate(dateText: string): Date {
  const { year, month, day } = parseDateParts(dateText);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

/**
 * Validate a `YYYY-MM-DD` query parameter and reject impossible days such as `2026-02-31`, which the
 * pattern alone would accept.
 */
export function assertDateText(value: unknown, label: string): string {
  const text = String(value ?? '').trim();

  if (!DATE_TEXT_PATTERN.test(text)) {
    throw badRequest(`${label} must be in YYYY-MM-DD format`);
  }

  const { year, month, day } = parseDateParts(text);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw badRequest(`${label} is not a valid calendar date`);
  }

  return text;
}

export function listDatesInclusive(startDateText: string, endDateText: string): string[] {
  const dates: string[] = [];
  const current = startOfLocalDate(startDateText);
  const end = startOfLocalDate(endDateText);

  while (current <= end) {
    dates.push(formatLocalDate(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

export function getWeekday(dateText: string): number {
  return startOfLocalDate(dateText).getDay();
}

export function parseDeviceTimestampValue(timestamp: string | null | undefined): Date | null {
  const match = DEVICE_TIMESTAMP_PATTERN.exec(String(timestamp ?? ''));

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match as unknown as string[];
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

/** Display-ready `h:mm:ss AM/PM`; empty string when there is no timestamp (blank cell in exports). */
export function formatLocalTime(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  const parsed = parseDeviceTimestampValue(value) ?? new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  const rawHours = parsed.getHours();
  const hours = rawHours % 12 || 12;
  const minutes = String(parsed.getMinutes()).padStart(2, '0');
  const seconds = String(parsed.getSeconds()).padStart(2, '0');
  const period = rawHours >= 12 ? 'PM' : 'AM';

  return `${hours}:${minutes}:${seconds} ${period}`;
}

/**
 * A check-in counts as late only once the threshold minute has fully elapsed, so with a 09:30 threshold
 * `09:30:59` is still on time and `09:31:00` is late.
 */
export function isLateCheckIn(checkIn: Date, threshold: LateThreshold): boolean {
  const hour = checkIn.getHours();

  if (hour > threshold.lateAfterHour) {
    return true;
  }

  return hour === threshold.lateAfterHour && checkIn.getMinutes() > threshold.lateAfterMinute;
}

export function resolveAttendanceStatus(
  checkInAt: string | null | undefined,
  threshold: LateThreshold,
): AttendanceReportStatus {
  if (!checkInAt) {
    return STATUS.ABSENT;
  }

  const checkIn = parseDeviceTimestampValue(checkInAt) ?? new Date(checkInAt);

  if (Number.isNaN(checkIn.getTime())) {
    return STATUS.ABSENT;
  }

  return isLateCheckIn(checkIn, threshold) ? STATUS.LATE : STATUS.PRESENT;
}

export function buildWeeklyHolidayDateSet(
  dateList: readonly string[],
  weeklyHolidayWeekdays: readonly number[],
): Set<string> {
  const holidayWeekdays = new Set(weeklyHolidayWeekdays);

  return new Set(dateList.filter((dateText) => holidayWeekdays.has(getWeekday(dateText))));
}

/**
 * Government holidays win over weekly holidays so the report can name the actual holiday instead of
 * showing a generic weekend label.
 */
export function buildHolidayInfoMap(
  weeklyHolidayDates: ReadonlySet<string>,
  governmentHolidayMap: ReadonlyMap<string, GovernmentHoliday>,
): Map<string, HolidayInfo> {
  const holidayInfo = new Map<string, HolidayInfo>();

  for (const dateText of weeklyHolidayDates) {
    holidayInfo.set(dateText, { name: 'Weekly Holiday', type: 'weekly' });
  }

  for (const [dateText, holiday] of governmentHolidayMap.entries()) {
    holidayInfo.set(dateText, {
      name: holiday.localName || holiday.name || 'Government Holiday',
      type: 'government',
    });
  }

  return holidayInfo;
}

export function formatDisplayDate(dateText: string): string {
  const { year, month, day } = parseDateParts(dateText);
  return `${day} ${MONTH_NAMES[month - 1]?.slice(0, 3) ?? month} ${year}`;
}

/**
 * "June 2026" when the range covers exactly one calendar month, otherwise a plain
 * "01 Jun 2026 - 20 Jun 2026" span. Mirrors the heading used by the exported summary.
 */
export function buildRangeLabel(startDateText: string, endDateText: string): string {
  const start = parseDateParts(startDateText);
  const end = parseDateParts(endDateText);
  const lastDayOfStartMonth = new Date(start.year, start.month, 0).getDate();

  const coversWholeMonth =
    start.year === end.year &&
    start.month === end.month &&
    start.day === 1 &&
    end.day === lastDayOfStartMonth;

  if (coversWholeMonth) {
    return `${MONTH_NAMES[start.month - 1]} ${start.year}`;
  }

  if (startDateText === endDateText) {
    return formatDisplayDate(startDateText);
  }

  return `${formatDisplayDate(startDateText)} - ${formatDisplayDate(endDateText)}`;
}

export function escapeCsvValue(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/**
 * Wrap a value in a formula so Excel keeps it as literal text. Without this, Excel rewrites `2026-06-01`
 * and `9:47:00 AM` into its own locale formats. Empty values are left as a genuinely empty cell rather
 * than an `=""` formula, so absent and holiday rows read as blank.
 */
export function formatExcelText(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);

  if (!text) {
    return '';
  }

  return `="${text.replace(/"/g, '""')}"`;
}

/** Rows → CSV. `\r\n` separators because Excel wants them. */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(escapeCsvValue).join(',')).join('\r\n');
}
