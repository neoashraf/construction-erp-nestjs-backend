/**
 * HolidayService — weekly + government holidays behind `/api/holidays/*` (SUPPORTING_APIS_GUIDE §3).
 * These feed `/api/reports/*` directly: with no weekly holidays configured every weekend counts as a
 * working day and `attendancePercentage` comes out wrong, so this is part of the reports module, not an
 * optional extra.
 *
 * The two rules worth protecting when this is touched:
 *   - `setWeeklyHolidays` is a FULL REPLACE inside one transaction — `[]` clears the table. Callers get
 *     the normalised list back, so junk they sent is visibly dropped rather than silently stored.
 *   - `importFromApi` NEVER overwrites a `source: 'manual'` row. An admin's hand-entered holiday must
 *     survive the year-end sync; only `import` rows are refreshed.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { badRequest } from '../domain/attendance-rules';
import {
  GovernmentHolidayDto,
  normalizeDateText,
  normalizeHolidayName,
  normalizeLocalName,
  normalizeWeekdays,
  normalizeYear,
} from '../domain/holiday-rules';
import {
  ATTENDANCE_CONFIG_REPOSITORY,
  AttendanceConfigRepository,
} from '../domain/ports/attendance-config.repository';
import {
  PUBLIC_HOLIDAY_API_PORT,
  PublicHolidayApiPort,
} from '../domain/ports/public-holiday-api.port';

/** One row of the `import-excel` payload — the frontend parses the workbook, the API takes JSON. */
export interface HolidayRowInput {
  date?: unknown;
  name?: unknown;
  localName?: unknown;
}

@Injectable()
export class HolidayService {
  constructor(
    @Inject(ATTENDANCE_CONFIG_REPOSITORY) private readonly repo: AttendanceConfigRepository,
    @Inject(PUBLIC_HOLIDAY_API_PORT) private readonly api: PublicHolidayApiPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  // ── weekly ─────────────────────────────────────────────────────────────────────────────────────

  getWeeklyHolidays(actor: Actor): Promise<number[]> {
    return this.repo.listWeeklyHolidays(actor.companyId);
  }

  /** Full replace. Junk is dropped by `normalizeWeekdays`, not rejected (§3.2). */
  setWeeklyHolidays(weekdays: unknown, actor: Actor): Promise<number[]> {
    const normalized = normalizeWeekdays(weekdays);
    return this.uow.run(() => this.repo.replaceWeeklyHolidays(actor.companyId, normalized));
  }

  // ── government ─────────────────────────────────────────────────────────────────────────────────

  /** An absent or out-of-range `year` falls back to the current year rather than 400-ing (§3.2). */
  getGovernmentHolidays(year: unknown, actor: Actor): Promise<GovernmentHolidayDto[]> {
    return this.repo.listGovernmentHolidays(actor.companyId, normalizeYear(year));
  }

  /**
   * Hand-entered holidays are always stored as `manual`, whatever the body claims. `async` on purpose:
   * the normalisers throw, and a method that returns a Promise must REJECT rather than throw
   * synchronously, or a caller's `.catch()` never sees the validation error.
   */
  async createGovernmentHoliday(
    input: HolidayRowInput,
    actor: Actor,
  ): Promise<GovernmentHolidayDto> {
    const holiday = {
      date: normalizeDateText(input.date),
      name: normalizeHolidayName(input.name),
      localName: normalizeLocalName(input.localName),
      source: 'manual' as const,
    };
    return this.uow.run(() => this.repo.upsertGovernmentHoliday(actor.companyId, holiday));
  }

  /**
   * `import-excel` — the frontend parses the workbook and posts rows, so the backend needs no xlsx
   * dependency (§3.2). Every row is validated BEFORE anything is written, so a bad row at position 40
   * does not leave the first 39 imported. Rows land as `manual`: an operator uploaded them.
   */
  async importFromRows(holidays: unknown, actor: Actor): Promise<GovernmentHolidayDto[]> {
    if (!Array.isArray(holidays)) throw badRequest('holidays must be an array');

    const normalized = (holidays as HolidayRowInput[]).map((h) => ({
      date: normalizeDateText(h?.date),
      name: normalizeHolidayName(h?.name),
      localName: normalizeLocalName(h?.localName),
      source: 'manual' as const,
    }));

    return this.uow.run(async () => {
      const saved: GovernmentHolidayDto[] = [];
      for (const holiday of normalized) {
        saved.push(await this.repo.upsertGovernmentHoliday(actor.companyId, holiday));
      }
      return saved;
    });
  }

  /**
   * Year-end sync from the public-holiday feed. A row an admin entered by hand (`source: 'manual'`) is
   * SKIPPED, never overwritten — that is the whole reason `source` exists. Returns the full year after
   * the import so the caller sees the resulting state, manual rows included.
   */
  async importFromApi(year: unknown, actor: Actor): Promise<GovernmentHolidayDto[]> {
    const safeYear = normalizeYear(year);
    // The upstream fetch is deliberately OUTSIDE the transaction: a slow third party must not hold a
    // DB transaction open, and a failed fetch should change nothing.
    const upstream = await this.api.fetchPublicHolidays(safeYear);

    return this.uow.run(async () => {
      for (const holiday of upstream) {
        const existing = await this.repo.findGovernmentHolidaySource(actor.companyId, holiday.date);
        if (existing === 'manual') continue; // never clobber a hand-entered holiday
        await this.repo.upsertGovernmentHoliday(actor.companyId, {
          date: holiday.date,
          name: holiday.name,
          localName: holiday.localName,
          source: 'import',
        });
      }
      return this.repo.listGovernmentHolidays(actor.companyId, safeYear);
    });
  }

  /** False when the id does not belong to this company (or does not exist) — controller 404s. */
  deleteGovernmentHoliday(id: string, actor: Actor): Promise<boolean> {
    return this.uow.run(() => this.repo.deleteGovernmentHoliday(actor.companyId, id));
  }
}
