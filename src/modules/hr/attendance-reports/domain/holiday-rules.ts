/**
 * PURE normalisers for the attendance-settings and holiday endpoints (SUPPORTING_APIS_GUIDE §3, §6).
 * No NestJS, no TypeORM — every rule here is unit-testable on its own.
 *
 * The deliberate behaviours, each of which the guide calls out:
 *   - `weekdays` is normalised, not validated: junk is dropped rather than 400'd, duplicates collapse,
 *     and the result is ascending. `PUT /weekly` is a FULL REPLACE, so `[]` clears every weekly holiday.
 *   - `year` falls back to the current year instead of 400-ing when absent or out of the 2000–2100 range.
 *   - date/name DO throw, because a malformed holiday row is a caller mistake worth surfacing.
 */
import { DATE_TEXT_PATTERN, badRequest } from './attendance-rules';

export type HolidaySource = 'manual' | 'import';

/** A stored government-holiday row as the API returns it. */
export interface GovernmentHolidayDto {
  id: string;
  date: string;
  name: string;
  localName: string | null;
  source: HolidaySource;
}

/** Drop non-integers and out-of-range values, collapse duplicates, sort ascending. Never throws. */
export function normalizeWeekdays(weekdays: unknown): number[] {
  if (!Array.isArray(weekdays)) return [];

  return Array.from(
    new Set(
      weekdays
        .map((weekday) => Number(weekday))
        .filter((weekday) => Number.isInteger(weekday) && weekday >= 0 && weekday <= 6),
    ),
  ).sort((a, b) => a - b);
}

/** Out-of-range or unparseable year → the current year (the guide's rule: fall back, do not 400). */
export function normalizeYear(year: unknown, now: Date = new Date()): number {
  const value = Number(year);
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    return now.getFullYear();
  }
  return value;
}

export function normalizeDateText(date: unknown): string {
  const text = String(date ?? '').trim();
  if (!DATE_TEXT_PATTERN.test(text)) {
    throw badRequest('Holiday date must be in YYYY-MM-DD format');
  }
  return text;
}

export function normalizeHolidayName(name: unknown): string {
  const text = String(name ?? '').trim();
  if (!text) throw badRequest('Holiday name is required');
  return text;
}

export function normalizeLocalName(localName: unknown): string | null {
  if (localName === null || localName === undefined) return null;
  const text = String(localName).trim();
  return text ? text : null;
}

/** `lateAfter` is display convenience; the two integers are the source of truth. */
export function formatLateAfter(lateAfterHour: number, lateAfterMinute: number): string {
  return `${String(lateAfterHour).padStart(2, '0')}:${String(lateAfterMinute).padStart(2, '0')}`;
}

/** Validate one component of the late cut-off, with the guide's exact 400 message. */
export function normalizeTimeUnit(value: unknown, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw badRequest(`${label} must be an integer between 0 and ${max}`);
  }
  return parsed;
}
