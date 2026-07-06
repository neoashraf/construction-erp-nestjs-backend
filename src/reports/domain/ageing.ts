/**
 * Ageing bucketing (RPT · FR-RPT-017) — PURE domain (no Nest, no TypeORM, no I/O). Given an IPC's due date
 * and the report as-of date, classify how overdue its outstanding is into one of four presentation buckets.
 * This is a DISPLAY classification only — the outstanding TOTAL is SAL's (FR-RPT-016); RPT never re-totals.
 *
 * Boundaries (days overdue = as-of − due date, whole days), each boundary buckets exactly:
 *   ≤ 30 → CURRENT   (0–30 overdue, and anything not yet due)
 *   31–60 → D31_60
 *   61–90 → D61_90
 *   ≥ 91 → D90_PLUS
 * e.g. 30→CURRENT, 31→D31_60, 60→D31_60, 61→D61_90, 90→D61_90, 91→D90_PLUS.
 */
import { AgeingBucket } from './report-result.model';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a 'YYYY-MM-DD' (or ISO) date into a UTC-midnight epoch-day count. Null if unparsable. */
function toUtcDay(isoDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * Whole days `dueDate` is overdue relative to `asOf` (negative if not yet due). Returns 0 when either date
 * is unparsable, so a bad date degrades to CURRENT rather than throwing in a read path.
 */
export function daysOverdue(dueDate: string, asOf: string): number {
  const due = toUtcDay(dueDate);
  const at = toUtcDay(asOf);
  if (due === null || at === null) return 0;
  return at - due;
}

/** Classify `outstanding` age from `dueDate` relative to `asOf` into a display bucket (FR-RPT-017). */
export function ageingBucket(dueDate: string, asOf: string): AgeingBucket {
  const days = daysOverdue(dueDate, asOf);
  if (days <= 30) return 'CURRENT';
  if (days <= 60) return 'D31_60';
  if (days <= 90) return 'D61_90';
  return 'D90_PLUS';
}
