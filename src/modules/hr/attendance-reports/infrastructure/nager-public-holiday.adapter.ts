/**
 * NagerPublicHolidayAdapter (INFRASTRUCTURE) — fetches public holidays from date.nager.at
 * (SUPPORTING_APIS_GUIDE §3.3). OUTBOUND NETWORK CALL: `POST /api/holidays/government/import` reaches a
 * third-party service at request time, so a slow or down upstream shows up as a slow import. A 10s
 * timeout via AbortController keeps that bounded instead of hanging the request thread.
 *
 * Country and base URL come from config (`HOLIDAY_API_BASE_URL`, `HOLIDAY_API_COUNTRY`, default
 * `BD` = Bangladesh) so another deployment does not need a code change. Rows are filtered to
 * `types` containing `Public`; feeds that omit `types` are kept, matching the source behaviour.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PublicHoliday,
  PublicHolidayApiPort,
} from '../domain/ports/public-holiday-api.port';

const DEFAULT_BASE_URL = 'https://date.nager.at/api/v3/PublicHolidays';
const DEFAULT_COUNTRY = 'BD';
const TIMEOUT_MS = 10_000;

interface NagerHoliday {
  date?: string;
  name?: string;
  localName?: string;
  types?: string[];
}

@Injectable()
export class NagerPublicHolidayAdapter implements PublicHolidayApiPort {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async fetchPublicHolidays(year: number): Promise<PublicHoliday[]> {
    const baseUrl = this.config.get<string>('HOLIDAY_API_BASE_URL') ?? DEFAULT_BASE_URL;
    const country = this.config.get<string>('HOLIDAY_API_COUNTRY') ?? DEFAULT_COUNTRY;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/${year}/${country}`, { signal: controller.signal });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Holiday import failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`Holiday import failed: ${response.status} ${response.statusText}`);
    }

    const holidays = (await response.json()) as NagerHoliday[];
    if (!Array.isArray(holidays)) return [];

    return holidays
      .filter((h) => (Array.isArray(h.types) ? h.types.includes('Public') : true))
      .map((h) => ({
        date: String(h.date ?? ''),
        name: h.name || h.localName || 'Government Holiday',
        localName: h.localName || null,
      }))
      .filter((h) => h.date.length > 0);
  }
}
