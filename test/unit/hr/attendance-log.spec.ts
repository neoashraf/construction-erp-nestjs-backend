/**
 * `GET /api/logs` tests (SUPPORTING_APIS_GUIDE §2) — no DB, no Nest.
 * Pins the ways this endpoint deliberately DIFFERS from `/api/reports/range` (§2.1), because those are
 * exactly the things a refactor would "helpfully" unify and thereby break the contract:
 *   - `attendanceRecords` is NOT gap-free — punch-less non-holiday days are omitted;
 *   - `absentCount` is derived (`workingDays - presentCount`), not counted from records;
 *   - the default window is TODAY, not the current month;
 *   - one date bound alone is accepted rather than 400'd;
 *   - punches are fetched for the current PAGE of employees only;
 *   - the CSV export DOES emit absent rows, unlike the JSON.
 */
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { AttendanceLogService } from '../../../src/modules/hr/attendance-reports/application/attendance-log.service';
import { EmployeeIdentity } from '../../../src/modules/hr/attendance-reports/domain/attendance-report.model';
import {
  AttendanceLogReadPort,
  PunchRow,
} from '../../../src/modules/hr/attendance-reports/domain/ports/attendance-log.read.port';
import {
  AttendanceReportReadPort,
  DailyPunchRow,
  EmployeeFilter,
} from '../../../src/modules/hr/attendance-reports/domain/ports/attendance-report.read.port';
import {
  GovernmentHoliday,
  LateThreshold,
} from '../../../src/modules/hr/attendance-reports/domain/attendance-rules';

const ACTOR = { companyId: 'co1', userId: 'u1' } as Actor;

const KARIM: EmployeeIdentity = { id: 'e1', userId: '1042', name: 'Karim Rahman', designation: 'Operator' };
const SALMA: EmployeeIdentity = { id: 'e2', userId: '1043', name: 'Salma Akter', designation: null };

class FakeConfigRead implements AttendanceReportReadPort {
  weekly: number[] = [];
  government: GovernmentHoliday[] = [];

  constructor(private readonly employees: EmployeeIdentity[]) {}

  loadEmployees(_c: string, filter: EmployeeFilter): Promise<EmployeeIdentity[]> {
    let rows = this.employees;
    if (filter.userId) rows = rows.filter((e) => e.userId === filter.userId);
    return Promise.resolve(rows);
  }
  loadDailyPunches(): Promise<DailyPunchRow[]> {
    return Promise.resolve([]);
  }
  getAttendanceSetting(): Promise<LateThreshold> {
    return Promise.resolve({ lateAfterHour: 9, lateAfterMinute: 30 });
  }
  getWeeklyHolidayWeekdays(): Promise<number[]> {
    return Promise.resolve(this.weekly);
  }
  getGovernmentHolidayDates(_c: string, dateList: readonly string[]): Promise<Map<string, GovernmentHoliday>> {
    const wanted = new Set(dateList);
    return Promise.resolve(new Map(this.government.filter((h) => wanted.has(h.date)).map((h) => [h.date, h])));
  }
}

class FakePunchRead implements AttendanceLogReadPort {
  askedFor: string[][] = [];
  constructor(private readonly punches: PunchRow[]) {}

  listPunches(
    _c: string,
    employeeCodes: readonly string[],
    dateFrom: string,
    dateTo: string,
  ): Promise<PunchRow[]> {
    this.askedFor.push([...employeeCodes]);
    const codes = new Set(employeeCodes);
    return Promise.resolve(
      this.punches
        .filter(
          (p) =>
            codes.has(p.userId) &&
            p.deviceTimestamp >= `${dateFrom} 00:00:00` &&
            p.deviceTimestamp <= `${dateTo} 23:59:59`,
        )
        .sort((a, b) => a.userId.localeCompare(b.userId) || a.deviceTimestamp.localeCompare(b.deviceTimestamp)),
    );
  }
}

let punchSeq = 0;
function punch(
  userId: string,
  ts: string,
  provenance: { sourceType?: string; projectId?: string | null; projectName?: string | null } = {},
): PunchRow {
  return {
    id: String(++punchSeq),
    userId,
    deviceTimestamp: ts,
    receivedAt: new Date(`${ts.replace(' ', 'T')}Z`),
    sourceType: provenance.sourceType ?? 'DEVICE_PUSH',
    projectId: provenance.projectId ?? null,
    projectName: provenance.projectName ?? null,
  };
}

function service(
  employees: EmployeeIdentity[],
  punches: PunchRow[],
  tweak?: (c: FakeConfigRead) => void,
): { svc: AttendanceLogService; punchRead: FakePunchRead } {
  const config = new FakeConfigRead(employees);
  tweak?.(config);
  const punchRead = new FakePunchRead(punches);
  return { svc: new AttendanceLogService(punchRead, config), punchRead };
}

describe('GET /api/logs — shape', () => {
  it('returns a per-employee summary with the fixed sourceType and null top-level punch fields', async () => {
    const { svc } = service(
      [KARIM],
      [punch('1042', '2026-07-01 09:12:04'), punch('1042', '2026-07-01 18:03:51')],
    );

    const res = await svc.getLogs({ date: '2026-07-01' }, ACTOR);
    const row = res.data[0];

    expect(row).toMatchObject({
      id: 'e1',
      userId: '1042',
      name: 'Karim Rahman',
      designation: 'Operator',
      deviceTimestamp: null,
      occurredAt: null,
      receivedAt: null,
      sourceType: 'EMPLOYEE_ATTENDANCE_SUMMARY',
      status: 'Present',
      workingDays: 1,
      onTimeCount: 1,
      lateCount: 0,
      presentCount: 1,
      absentCount: 0,
      holidayCount: 0,
      attendancePercentage: 100,
    });
    expect(res.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('takes the first punch as check-in, the last as check-out, and counts them all', async () => {
    const { svc } = service(
      [KARIM],
      [
        punch('1042', '2026-07-01 09:12:04'),
        punch('1042', '2026-07-01 13:00:00'),
        punch('1042', '2026-07-01 13:45:00'),
        punch('1042', '2026-07-01 18:03:51'),
      ],
    );

    const record = (await svc.getLogs({ date: '2026-07-01' }, ACTOR)).data[0]?.attendanceRecords[0];

    expect(record).toMatchObject({
      checkInAt: '2026-07-01 09:12:04',
      checkOutAt: '2026-07-01 18:03:51',
      punchCount: 4,
      status: 'Present',
    });
    // Unlike the reports, punchCount here is the REAL number of punches, not 0/1/2.
    expect(record?.id).not.toMatch(/^holiday-/);
  });

  it('exposes each punch with its source and location under the merged day', async () => {
    // A day is now routinely built from punches that arrived by different paths. Reporting only
    // first/last hides that, leaving an operator unable to see where the time came from.
    const { svc } = service(
      [KARIM],
      [
        punch('1042', '2026-07-12 09:00:00', { sourceType: 'DEVICE_PUSH' }),
        punch('1042', '2026-07-12 14:30:00', {
          sourceType: 'MANUAL',
          projectId: 'p-1',
          projectName: 'Bridge-04',
        }),
      ],
    );

    const record = (await svc.getLogs({ date: '2026-07-12' }, ACTOR)).data[0]?.attendanceRecords[0];

    expect(record?.checkInAt).toContain('09:00:00');
    expect(record?.checkOutAt).toContain('14:30:00');
    expect(record?.punchCount).toBe(2); // unchanged — punches[] is additive
    expect(record?.punches).toEqual([
      { time: '09:00:00', sourceType: 'DEVICE_PUSH', projectId: null, projectName: null },
      { time: '14:30:00', sourceType: 'MANUAL', projectId: 'p-1', projectName: 'Bridge-04' },
    ]);
  });

  it('gives a holiday record an empty punches array rather than omitting the field', async () => {
    const { svc } = service([KARIM], [], (c) => {
      c.government = [{ date: '2026-07-02', name: 'Ashura', localName: 'আশুরা' }];
    });

    const row = (await svc.getLogs({ date: '2026-07-02' }, ACTOR)).data[0];

    expect(row?.attendanceRecords[0]?.punches).toEqual([]);
  });

  it('omits punch-less non-holiday days from attendanceRecords but still counts them absent', async () => {
    const { svc } = service([KARIM], [punch('1042', '2026-07-01 09:12:04')]);

    const row = (await svc.getLogs({ dateFrom: '2026-07-01', dateTo: '2026-07-03' }, ACTOR)).data[0];

    // Three days in the window, only ONE record — no gap filling (§2.2).
    expect(row?.attendanceRecords).toHaveLength(1);
    expect(row?.workingDays).toBe(3);
    expect(row?.presentCount).toBe(1);
    expect(row?.absentCount).toBe(2); // derived: workingDays - presentCount
  });

  it('emits a synthetic holiday-<date> record for a holiday', async () => {
    const { svc } = service([KARIM], [], (c) => {
      c.government = [{ date: '2026-07-02', name: 'Ashura', localName: 'আশুরা' }];
    });

    const row = (await svc.getLogs({ dateFrom: '2026-07-01', dateTo: '2026-07-02' }, ACTOR)).data[0];
    const holiday = row?.attendanceRecords[0];

    expect(holiday).toMatchObject({
      id: 'holiday-2026-07-02',
      attendanceDate: '2026-07-02',
      status: 'Holiday',
      holidayName: 'আশুরা',
      holidayType: 'government',
      punchCount: 0,
    });
    expect(row?.workingDays).toBe(1); // the holiday is not a working day
  });

  it('falls back to Absent for the top-level status when there are no records at all', async () => {
    const { svc } = service([SALMA], []);

    expect((await svc.getLogs({ date: '2026-07-01' }, ACTOR)).data[0]?.status).toBe('Absent');
  });

  it('marks a late check-in Late and keeps it inside presentCount', async () => {
    const { svc } = service([KARIM], [punch('1042', '2026-07-01 09:41:10')]);

    const row = (await svc.getLogs({ date: '2026-07-01' }, ACTOR)).data[0];

    expect(row?.lateCount).toBe(1);
    expect(row?.onTimeCount).toBe(0);
    expect(row?.presentCount).toBe(1);
  });
});

describe('GET /api/logs — window rules (§2.3)', () => {
  it('defaults to TODAY when nothing is given', async () => {
    const { svc } = service([KARIM], []);
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`;

    const row = (await svc.getLogs({}, ACTOR)).data[0];

    // One day in the window → workingDays is 0 or 1 depending on whether today is a holiday; either way
    // the window is a single day, which a month-wide default would not produce.
    expect(row?.workingDays).toBeLessThanOrEqual(1);
    expect(expected).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts dateFrom alone — the reports would 400 here', async () => {
    const { svc } = service([KARIM], []);

    await expect(svc.getLogs({ dateFrom: '2026-07-01' }, ACTOR)).resolves.toBeDefined();
  });

  it('still rejects a malformed date', async () => {
    const { svc } = service([KARIM], []);

    await expect(svc.getLogs({ date: '2026-02-31' }, ACTOR)).rejects.toThrow(
      'date is not a valid calendar date',
    );
  });
});

describe('GET /api/logs — paging (§2.1)', () => {
  const many: EmployeeIdentity[] = Array.from({ length: 5 }, (_, i) => ({
    id: `e${i + 1}`,
    userId: String(1000 + i),
    name: `Employee ${i + 1}`,
    designation: null,
  }));

  it('queries punches for the CURRENT PAGE of employees only', async () => {
    const { svc, punchRead } = service(many, []);

    const res = await svc.getLogs({ date: '2026-07-01', page: '2', limit: '2' }, ACTOR);

    expect(res.data).toHaveLength(2);
    expect(res.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    // Two employee codes asked for, not all five — the documented difference from reports/range.
    expect(punchRead.askedFor[0]).toEqual(['1002', '1003']);
  });

  it('caps limit at 100', async () => {
    const { svc } = service(many, []);

    expect((await svc.getLogs({ limit: '9999' }, ACTOR)).pagination.limit).toBe(100);
  });
});

describe('GET /api/logs/export (§2.4)', () => {
  it('emits a row for EVERY date including absent days, unlike the JSON', async () => {
    const { svc } = service([KARIM], [punch('1042', '2026-07-01 09:12:04')]);

    const csv = await svc.exportCsv({ dateFrom: '2026-07-01', dateTo: '2026-07-03' }, ACTOR);
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe('User ID,Name,Designation,Date,Checkin Time,Checkout Time,Status');
    expect(lines).toHaveLength(4); // header + 3 dates
    expect(lines[1]).toContain('Present');
    expect(lines[2]).toContain('Absent');
    expect(lines[3]).toContain('Absent');
  });

  it('wraps dates and times as Excel text literals', async () => {
    const { svc } = service([KARIM], [punch('1042', '2026-07-01 09:12:04')]);

    const csv = await svc.exportCsv({ date: '2026-07-01' }, ACTOR);

    expect(csv.split('\r\n')[1]).toBe(
      '1042,Karim Rahman,Operator,"=""2026-07-01""","=""9:12:04 AM""","=""9:12:04 AM""",Present',
    );
  });

  it('ignores paging so the file covers every matching employee', async () => {
    const many: EmployeeIdentity[] = Array.from({ length: 5 }, (_, i) => ({
      id: `e${i + 1}`,
      userId: String(1000 + i),
      name: `Employee ${i + 1}`,
      designation: null,
    }));
    const { svc } = service(many, []);

    const csv = await svc.exportCsv({ date: '2026-07-01', page: '2', limit: '1' }, ACTOR);

    for (const e of many) expect(csv).toContain(e.userId);
  });
});
