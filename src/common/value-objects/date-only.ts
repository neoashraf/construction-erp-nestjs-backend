/**
 * DateOnly — a calendar date with no time/timezone, stored/exchanged as ISO `YYYY-MM-DD`.
 * Voucher dates, period dates, financial-year bounds are all DateOnly. (skill §2.2, CLAUDE.md)
 * PURE value object. Display formatting (DD/MM/YYYY for Bangladesh) is a presentation concern.
 */
import { ValueObject } from '../domain/domain';
import { ValidationError } from '../errors/domain-error';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class DateOnly extends ValueObject {
  private constructor(readonly value: string) {
    super();
  }

  /** Parse an ISO `YYYY-MM-DD` string; rejects malformed or non-existent dates. */
  static of(raw: string): DateOnly {
    const trimmed = raw.trim();
    if (!ISO_DATE.test(trimmed)) {
      throw new ValidationError(`Invalid date (expected YYYY-MM-DD): '${raw}'`, { value: raw });
    }
    const [y, m, d] = trimmed.split('-').map((p) => parseInt(p, 10));
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      throw new ValidationError(`Non-existent calendar date: '${raw}'`, { value: raw });
    }
    return new DateOnly(trimmed);
  }

  /** Build from a JS Date using its UTC components. */
  static fromDate(date: Date): DateOnly {
    const y = date.getUTCFullYear();
    const m = `${date.getUTCMonth() + 1}`.padStart(2, '0');
    const d = `${date.getUTCDate()}`.padStart(2, '0');
    return new DateOnly(`${y}-${m}-${d}`);
  }

  isBefore(other: DateOnly): boolean {
    return this.value < other.value;
  }

  isAfter(other: DateOnly): boolean {
    return this.value > other.value;
  }

  override equals(other: DateOnly): boolean {
    return this.value === other.value;
  }

  override toString(): string {
    return this.value;
  }
}
