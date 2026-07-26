/**
 * Write side of the three attendance-report configuration tables (SUPPORTING_APIS_GUIDE §3, §6).
 * Kept separate from `AttendanceReportReadPort`: that port serves the reports and is read-only, this one
 * is the config CRUD behind `/api/settings/attendance` and `/api/holidays/*`. Every method is
 * companyId-scoped (ADR-0002 F3).
 */
import { GovernmentHolidayDto, HolidaySource } from '../holiday-rules';

/** The stored cut-off plus when it was last changed; `updatedAt` is null when no row exists. */
export interface StoredAttendanceSetting {
  lateAfterHour: number;
  lateAfterMinute: number;
  updatedAt: Date | null;
}

export interface UpsertGovernmentHolidayInput {
  date: string;
  name: string;
  localName: string | null;
  source: HolidaySource;
}

export const ATTENDANCE_CONFIG_REPOSITORY = Symbol('ATTENDANCE_CONFIG_REPOSITORY');

export interface AttendanceConfigRepository {
  /** Null when the company has no row — the caller substitutes the 09:30 default. */
  findSetting(companyId: string): Promise<StoredAttendanceSetting | null>;

  upsertSetting(
    companyId: string,
    lateAfterHour: number,
    lateAfterMinute: number,
  ): Promise<StoredAttendanceSetting>;

  listWeeklyHolidays(companyId: string): Promise<number[]>;

  /** FULL REPLACE — weekdays not in the list are deleted. Must run in one transaction. */
  replaceWeeklyHolidays(companyId: string, weekdays: readonly number[]): Promise<number[]>;

  /** All government holidays in the given calendar year, date ascending. */
  listGovernmentHolidays(companyId: string, year: number): Promise<GovernmentHolidayDto[]>;

  upsertGovernmentHoliday(
    companyId: string,
    input: UpsertGovernmentHolidayInput,
  ): Promise<GovernmentHolidayDto>;

  /** The `source` of an existing row, or null if the date is free — lets an import skip manual rows. */
  findGovernmentHolidaySource(companyId: string, date: string): Promise<HolidaySource | null>;

  /** Returns false when the id does not exist (so the controller can 404 rather than 500). */
  deleteGovernmentHoliday(companyId: string, id: string): Promise<boolean>;
}
