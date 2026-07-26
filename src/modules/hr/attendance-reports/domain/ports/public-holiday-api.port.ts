/**
 * The external public-holiday feed behind `POST /api/holidays/government/import`
 * (SUPPORTING_APIS_GUIDE §3.3 — date.nager.at). Behind a port so the import use case is unit-testable
 * with a fake and so swapping the provider (or the country) is one adapter change, not a service edit.
 */

/** One holiday as the upstream feed reports it, already filtered to public holidays. */
export interface PublicHoliday {
  date: string; // 'YYYY-MM-DD'
  name: string;
  localName: string | null;
}

export const PUBLIC_HOLIDAY_API_PORT = Symbol('PUBLIC_HOLIDAY_API_PORT');

export interface PublicHolidayApiPort {
  /** Throws when the upstream call fails — the caller surfaces it rather than importing nothing. */
  fetchPublicHolidays(year: number): Promise<PublicHoliday[]>;
}
