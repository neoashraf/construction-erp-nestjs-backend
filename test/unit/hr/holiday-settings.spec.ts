/**
 * `/api/settings/attendance` + `/api/holidays/*` tests (SUPPORTING_APIS_GUIDE §3, §6) — no DB, no Nest.
 * Drives the services through a fake repository/API so every rule in the guide's verification table is
 * asserted: weekday normalisation, the full-replace semantics of `PUT /weekly`, the year fallback, the
 * 09:30 setting fallback, the exact 400 messages, and — the one that actually matters in production —
 * that an API import NEVER overwrites a hand-entered `manual` holiday.
 */
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { AttendanceSettingService } from '../../../src/modules/hr/attendance-reports/application/attendance-setting.service';
import { HolidayService } from '../../../src/modules/hr/attendance-reports/application/holiday.service';
import {
  GovernmentHolidayDto,
  HolidaySource,
  normalizeWeekdays,
  normalizeYear,
} from '../../../src/modules/hr/attendance-reports/domain/holiday-rules';
import {
  AttendanceConfigRepository,
  StoredAttendanceSetting,
  UpsertGovernmentHolidayInput,
} from '../../../src/modules/hr/attendance-reports/domain/ports/attendance-config.repository';
import {
  PublicHoliday,
  PublicHolidayApiPort,
} from '../../../src/modules/hr/attendance-reports/domain/ports/public-holiday-api.port';

const ACTOR = { companyId: 'co1', userId: 'u1' } as Actor;

/** Pass-through UnitOfWork — these tests assert behaviour, not transaction plumbing. */
const uow = { run: <T>(fn: () => Promise<T> | T): Promise<T> => Promise.resolve(fn()) };

class FakeConfigRepo implements AttendanceConfigRepository {
  setting: StoredAttendanceSetting | null = null;
  weekly: number[] = [];
  government: GovernmentHolidayDto[] = [];
  private seq = 0;

  findSetting(): Promise<StoredAttendanceSetting | null> {
    return Promise.resolve(this.setting);
  }

  upsertSetting(
    _companyId: string,
    lateAfterHour: number,
    lateAfterMinute: number,
    latesPerDeductedDay?: number,
  ): Promise<StoredAttendanceSetting> {
    // Partial, like the real adapter: an omitted value keeps what is stored (default 3).
    this.setting = {
      lateAfterHour,
      lateAfterMinute,
      latesPerDeductedDay: latesPerDeductedDay ?? this.setting?.latesPerDeductedDay ?? 3,
      updatedAt: new Date('2026-07-20T06:11:03Z'),
    };
    return Promise.resolve(this.setting);
  }

  listWeeklyHolidays(): Promise<number[]> {
    return Promise.resolve([...this.weekly].sort((a, b) => a - b));
  }

  replaceWeeklyHolidays(_companyId: string, weekdays: readonly number[]): Promise<number[]> {
    this.weekly = [...weekdays];
    return this.listWeeklyHolidays();
  }

  listGovernmentHolidays(_companyId: string, year: number): Promise<GovernmentHolidayDto[]> {
    return Promise.resolve(
      this.government
        .filter((h) => h.date.startsWith(String(year)))
        .sort((a, b) => a.date.localeCompare(b.date)),
    );
  }

  upsertGovernmentHoliday(
    _companyId: string,
    input: UpsertGovernmentHolidayInput,
  ): Promise<GovernmentHolidayDto> {
    const existing = this.government.find((h) => h.date === input.date);
    if (existing) {
      Object.assign(existing, {
        name: input.name,
        localName: input.localName,
        source: input.source,
      });
      return Promise.resolve(existing);
    }
    const row: GovernmentHolidayDto = { id: `h${++this.seq}`, ...input };
    this.government.push(row);
    return Promise.resolve(row);
  }

  findGovernmentHolidaySource(_companyId: string, date: string): Promise<HolidaySource | null> {
    return Promise.resolve(this.government.find((h) => h.date === date)?.source ?? null);
  }

  deleteGovernmentHoliday(_companyId: string, id: string): Promise<boolean> {
    const before = this.government.length;
    this.government = this.government.filter((h) => h.id !== id);
    return Promise.resolve(this.government.length < before);
  }
}

class FakeHolidayApi implements PublicHolidayApiPort {
  constructor(private readonly rows: PublicHoliday[]) {}
  fetchPublicHolidays(): Promise<PublicHoliday[]> {
    return Promise.resolve(this.rows);
  }
}

function holidayService(repo: FakeConfigRepo, api: PublicHoliday[] = []): HolidayService {
  return new HolidayService(repo, new FakeHolidayApi(api), uow as never);
}

// ── pure normalisers ─────────────────────────────────────────────────────────────────────────────

describe('normalizeWeekdays', () => {
  it('drops junk and out-of-range values, collapses duplicates, sorts ascending', () => {
    expect(normalizeWeekdays([5, 5, 9, -1, 0, 'x'])).toEqual([0, 5]);
  });

  it('returns an empty array for a non-array', () => {
    expect(normalizeWeekdays('friday')).toEqual([]);
  });
});

describe('normalizeYear', () => {
  const now = new Date('2026-07-26T00:00:00Z');

  it('falls back to the current year for junk rather than throwing', () => {
    expect(normalizeYear('abcd', now)).toBe(2026);
    expect(normalizeYear(undefined, now)).toBe(2026);
    expect(normalizeYear(1990, now)).toBe(2026);
    expect(normalizeYear(2200, now)).toBe(2026);
  });

  it('accepts a year inside 2000–2100', () => {
    expect(normalizeYear('2031', now)).toBe(2031);
  });
});

// ── settings (§6) ────────────────────────────────────────────────────────────────────────────────

describe('AttendanceSettingService', () => {
  it('falls back to 09:30 with updatedAt null when the company has no row', async () => {
    const svc = new AttendanceSettingService(new FakeConfigRepo(), uow as never);

    expect(await svc.get(ACTOR)).toEqual({
      lateAfterHour: 9,
      lateAfterMinute: 30,
      lateAfter: '09:30',
      // The FR-HR-013a default travels with the threshold: an un-configured company still has a
      // well-defined penalty rule rather than none, so payroll never divides by an absent value.
      latesPerDeductedDay: 3,
      updatedAt: null,
    });
  });

  it('stores the threshold and derives lateAfter', async () => {
    const repo = new FakeConfigRepo();
    const svc = new AttendanceSettingService(repo, uow as never);

    const saved = await svc.set({ lateAfterHour: 8, lateAfterMinute: 5 }, ACTOR);

    expect(saved.lateAfter).toBe('08:05');
    expect(saved.lateAfterHour).toBe(8);
    expect((await svc.get(ACTOR)).lateAfter).toBe('08:05');
  });

  it('rejects an out-of-range hour and minute with the contracted messages', async () => {
    const svc = new AttendanceSettingService(new FakeConfigRepo(), uow as never);

    await expect(svc.set({ lateAfterHour: 25, lateAfterMinute: 0 }, ACTOR)).rejects.toThrow(
      'lateAfterHour must be an integer between 0 and 23',
    );
    await expect(svc.set({ lateAfterHour: 9, lateAfterMinute: 60 }, ACTOR)).rejects.toThrow(
      'lateAfterMinute must be an integer between 0 and 59',
    );
    await expect(svc.set({ lateAfterHour: 9.5, lateAfterMinute: 0 }, ACTOR)).rejects.toThrow(
      'lateAfterHour must be an integer between 0 and 23',
    );
  });

  it('does not write when validation fails', async () => {
    const repo = new FakeConfigRepo();
    const svc = new AttendanceSettingService(repo, uow as never);

    await expect(svc.set({ lateAfterHour: 25, lateAfterMinute: 0 }, ACTOR)).rejects.toThrow();
    expect(repo.setting).toBeNull();
  });
});

// ── weekly holidays (§3) ─────────────────────────────────────────────────────────────────────────

describe('HolidayService — weekly', () => {
  it('normalises what it stores and returns the cleaned list', async () => {
    const repo = new FakeConfigRepo();
    const svc = holidayService(repo);

    expect(await svc.setWeeklyHolidays([5, 5, 9, -1], ACTOR)).toEqual([5]);
    expect(await svc.getWeeklyHolidays(ACTOR)).toEqual([5]);
  });

  it('treats an empty array as a full clear', async () => {
    const repo = new FakeConfigRepo();
    const svc = holidayService(repo);
    await svc.setWeeklyHolidays([0, 5], ACTOR);

    expect(await svc.setWeeklyHolidays([], ACTOR)).toEqual([]);
    expect(repo.weekly).toEqual([]);
  });

  it('replaces rather than merges', async () => {
    const svc = holidayService(new FakeConfigRepo());
    await svc.setWeeklyHolidays([0, 5], ACTOR);

    expect(await svc.setWeeklyHolidays([6], ACTOR)).toEqual([6]);
  });
});

// ── government holidays (§3) ─────────────────────────────────────────────────────────────────────

describe('HolidayService — government', () => {
  it('always stores a hand-entered holiday as manual and keeps the local name', async () => {
    const svc = holidayService(new FakeConfigRepo());

    const holiday = await svc.createGovernmentHoliday(
      { date: '2026-03-26', name: 'Independence Day', localName: 'স্বাধীনতা দিবস' },
      ACTOR,
    );

    expect(holiday).toMatchObject({
      date: '2026-03-26',
      name: 'Independence Day',
      localName: 'স্বাধীনতা দিবস',
      source: 'manual',
    });
  });

  it('rejects a malformed date and a blank name', async () => {
    const svc = holidayService(new FakeConfigRepo());

    await expect(svc.createGovernmentHoliday({ date: '26/03/2026', name: 'X' }, ACTOR)).rejects.toThrow(
      'Holiday date must be in YYYY-MM-DD format',
    );
    await expect(
      svc.createGovernmentHoliday({ date: '2026-03-26', name: '  ' }, ACTOR),
    ).rejects.toThrow('Holiday name is required');
  });

  it('filters the listing to the requested year, falling back to the current year', async () => {
    const repo = new FakeConfigRepo();
    const svc = holidayService(repo);
    await svc.createGovernmentHoliday({ date: '2026-03-26', name: 'Independence Day' }, ACTOR);
    await svc.createGovernmentHoliday({ date: '2031-03-26', name: 'Independence Day' }, ACTOR);

    expect(await svc.getGovernmentHolidays('2031', ACTOR)).toHaveLength(1);
    expect((await svc.getGovernmentHolidays('2031', ACTOR))[0]?.date).toBe('2031-03-26');
  });

  it('deletes by id and reports a miss so the controller can 404', async () => {
    const repo = new FakeConfigRepo();
    const svc = holidayService(repo);
    const created = await svc.createGovernmentHoliday(
      { date: '2026-03-26', name: 'Independence Day' },
      ACTOR,
    );

    expect(await svc.deleteGovernmentHoliday(created.id, ACTOR)).toBe(true);
    expect(await svc.deleteGovernmentHoliday(created.id, ACTOR)).toBe(false);
  });
});

describe('HolidayService — import-excel rows', () => {
  it('rejects a non-array with the contracted message', async () => {
    const svc = holidayService(new FakeConfigRepo());

    await expect(svc.importFromRows('nope', ACTOR)).rejects.toThrow('holidays must be an array');
  });

  it('imports every row as manual', async () => {
    const svc = holidayService(new FakeConfigRepo());

    const saved = await svc.importFromRows(
      [
        { date: '2026-02-21', name: 'Language Martyrs Day', localName: 'শহীদ দিবস' },
        { date: '2026-03-26', name: 'Independence Day' },
      ],
      ACTOR,
    );

    expect(saved).toHaveLength(2);
    expect(saved.every((h) => h.source === 'manual')).toBe(true);
  });

  it('validates the WHOLE payload before writing anything', async () => {
    const repo = new FakeConfigRepo();
    const svc = holidayService(repo);

    await expect(
      svc.importFromRows(
        [{ date: '2026-02-21', name: 'Good row' }, { date: 'garbage', name: 'Bad row' }],
        ACTOR,
      ),
    ).rejects.toThrow('Holiday date must be in YYYY-MM-DD format');
    // The valid first row must NOT have been written — a partial import is worse than none.
    expect(repo.government).toHaveLength(0);
  });
});

describe('HolidayService — API import', () => {
  it('NEVER overwrites a manually entered holiday', async () => {
    const repo = new FakeConfigRepo();
    const svc = holidayService(repo, [
      { date: '2026-03-26', name: 'Independence Day (upstream)', localName: null },
      { date: '2026-12-16', name: 'Victory Day', localName: null },
    ]);
    await svc.createGovernmentHoliday(
      { date: '2026-03-26', name: 'My own name', localName: 'আমার নাম' },
      ACTOR,
    );

    const after = await svc.importFromApi(2026, ACTOR);

    const manual = after.find((h) => h.date === '2026-03-26');
    expect(manual).toMatchObject({ name: 'My own name', localName: 'আমার নাম', source: 'manual' });
    const imported = after.find((h) => h.date === '2026-12-16');
    expect(imported).toMatchObject({ name: 'Victory Day', source: 'import' });
  });

  it('refreshes an existing import row', async () => {
    const repo = new FakeConfigRepo();
    repo.government.push({
      id: 'h9', date: '2026-12-16', name: 'Stale name', localName: null, source: 'import',
    });
    const svc = holidayService(repo, [
      { date: '2026-12-16', name: 'Victory Day', localName: 'বিজয় দিবস' },
    ]);

    const after = await svc.importFromApi(2026, ACTOR);

    expect(after[0]).toMatchObject({ name: 'Victory Day', localName: 'বিজয় দিবস', source: 'import' });
  });

  it('returns the whole year, not just the imported rows', async () => {
    const repo = new FakeConfigRepo();
    const svc = holidayService(repo, [{ date: '2026-12-16', name: 'Victory Day', localName: null }]);
    await svc.createGovernmentHoliday({ date: '2026-03-26', name: 'Independence Day' }, ACTOR);

    expect(await svc.importFromApi(2026, ACTOR)).toHaveLength(2);
  });
});
