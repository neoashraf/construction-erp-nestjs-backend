/**
 * Fingerprint-device ingestion tests (SUPPORTING_APIS_GUIDE §4, §5) — no DB, no Nest.
 * Covers the guide's verification table: all four punch formats, the "one garbage line must not fail the
 * batch" rule, the 2-minute online window, and the tenancy guard that drops punches from an unregistered
 * device serial rather than guessing a company.
 */
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { AttendanceUserService } from '../../../src/modules/hr/attendance-reports/application/attendance-user.service';
import { DeviceIngestionService } from '../../../src/modules/hr/attendance-reports/application/device-ingestion.service';
import {
  DEVICE_ONLINE_WINDOW_MS,
  DeviceStatusService,
} from '../../../src/modules/hr/attendance-reports/application/device-status.service';
import {
  parseAttendancePayload,
  parseDeviceTimestamp,
  punchDayKey,
  punchTimeOfDay,
} from '../../../src/modules/hr/attendance-reports/domain/punch-payload.parser';
import {
  AttendanceUserCreateDefaults,
  AttendanceUserDto,
  AttendanceUserRepository,
  UpsertAttendanceUserInput,
} from '../../../src/modules/hr/attendance-reports/domain/ports/attendance-user.repository';
import {
  DeviceMapping,
  PunchIngestionRepository,
  PunchToStore,
  ReconcileOutcome,
} from '../../../src/modules/hr/attendance-reports/domain/ports/punch-ingestion.repository';

const ACTOR = { companyId: 'co1', userId: 'u1' } as Actor;
const uow = { run: <T>(fn: () => Promise<T> | T): Promise<T> => Promise.resolve(fn()) };

/**
 * Minimal ConfigService stand-in for the `device` namespace. `defaultCompanyId` empty by
 * default, which is the safe production posture: an unregistered serial is DROPPED rather
 * than auto-registered. Pass an id to exercise the auto-registration path.
 */
function deviceConfigService(defaultCompanyId = '') {
  return {
    getOrThrow: () => ({
      ip: '',
      port: 4370,
      inPort: 5200,
      timeoutMs: 10000,
      defaultCompanyId,
    }),
  } as never;
}

// ── §5.3 payload parser ──────────────────────────────────────────────────────────────────────────

describe('parseAttendancePayload', () => {
  it('parses the tab-separated key-value format with vendor aliases', () => {
    const { records } = parseAttendancePayload(
      'PIN=1042\tDateTime=2026-07-26 09:12:04\tStatus=0',
    );
    expect(records).toEqual([
      { type: 'ATTLOG', userId: '1042', timestamp: '2026-07-26 09:12:04', status: '0' },
    ]);
  });

  it('accepts userid / enrollnumber / personnelid as aliases for pin', () => {
    for (const key of ['userid', 'enrollnumber', 'personnelid']) {
      const { records } = parseAttendancePayload(`${key}=77\ttime=2026-07-26 08:00:00`);
      expect(records[0]?.userId).toBe('77');
    }
  });

  it('parses the ATTLOG-prefixed format', () => {
    const { records } = parseAttendancePayload('ATTLOG 1042 2026-07-26 09:12:04 0');
    expect(records[0]).toMatchObject({ userId: '1042', timestamp: '2026-07-26 09:12:04' });
  });

  it('parses the plain tab-separated format', () => {
    const { records } = parseAttendancePayload('1042\t2026-07-26 09:12:04\t0');
    expect(records[0]).toMatchObject({ type: 'TAB', userId: '1042' });
  });

  it('parses the comma-separated format', () => {
    const { records } = parseAttendancePayload('1042,2026-07-26 09:12:04,0');
    expect(records[0]).toMatchObject({ type: 'CSV', userId: '1042' });
  });

  it('keeps the good lines when one line is garbage — a bad punch never fails the batch', () => {
    const { records, ignoredLines } = parseAttendancePayload(
      ['1042,2026-07-26 09:12:04,0', '%%% not a punch %%%', '1043,2026-07-26 09:15:00,0'].join('\n'),
    );
    expect(records).toHaveLength(2);
    expect(ignoredLines).toEqual(['%%% not a punch %%%']);
  });

  it('ignores an echoed raw HTTP request line', () => {
    const { records, ignoredLines } = parseAttendancePayload(
      'GET /iclock/cdata HTTP/1.1\n1042,2026-07-26 09:12:04,0',
    );
    expect(records).toHaveLength(1);
    expect(ignoredLines).toHaveLength(1);
  });

  it('handles CRLF line endings and an empty payload', () => {
    expect(parseAttendancePayload('1042,2026-07-26 09:12:04,0\r\n').records).toHaveLength(1);
    expect(parseAttendancePayload('').records).toEqual([]);
  });
});

describe('device timestamp helpers', () => {
  it('extracts the calendar day and time of day without timezone maths', () => {
    expect(punchDayKey('2026-07-26 09:12:04')).toBe('2026-07-26');
    expect(punchTimeOfDay('2026-07-26 09:12:04')).toBe('09:12:04');
  });

  it('returns null for an unparseable timestamp rather than a wrong date', () => {
    expect(punchDayKey('26/07/2026')).toBeNull();
    expect(punchTimeOfDay('nonsense')).toBeNull();
    expect(parseDeviceTimestamp('nonsense')).toBeNull();
  });
});

// ── §4 device status ─────────────────────────────────────────────────────────────────────────────

describe('DeviceStatusService', () => {
  const hit = { method: 'POST', path: '/iclock/cdata?SN=ABC123', remoteAddress: '192.168.0.55' };

  it('reports offline before any device has been seen', () => {
    const status = new DeviceStatusService().getStatus();
    expect(status).toMatchObject({ status: 'offline', online: false, lastSeenAt: null, lastSeenAgeMs: null });
    expect(status.onlineWindowMs).toBe(DEVICE_ONLINE_WINDOW_MS);
  });

  it('reports online immediately after a device hit', () => {
    const svc = new DeviceStatusService();
    const now = new Date('2026-07-26T04:12:09Z');
    svc.markSeen({ ...hit, deviceSn: 'ABC123' }, now);

    expect(svc.getStatus(now)).toMatchObject({
      status: 'online',
      online: true,
      lastSeenAt: '2026-07-26T04:12:09.000Z',
      lastSeenAgeMs: 0,
      lastMethod: 'POST',
      lastPath: '/iclock/cdata?SN=ABC123',
      lastRemoteAddress: '192.168.0.55',
    });
  });

  it('stays online at the window edge and flips offline past it', () => {
    const svc = new DeviceStatusService();
    const seen = new Date('2026-07-26T04:00:00Z');
    svc.markSeen(hit, seen);

    const atEdge = new Date(seen.getTime() + DEVICE_ONLINE_WINDOW_MS);
    const pastEdge = new Date(seen.getTime() + DEVICE_ONLINE_WINDOW_MS + 1);

    expect(svc.getStatus(atEdge).online).toBe(true);
    expect(svc.getStatus(pastEdge).online).toBe(false);
    expect(svc.getStatus(pastEdge).status).toBe('offline');
  });
});

// ── §5 ingestion ─────────────────────────────────────────────────────────────────────────────────

class FakePunchRepo implements PunchIngestionRepository {
  stored: PunchToStore[] = [];
  reconciledDays: Array<{ userId: string; attendanceDate: string }> = [];
  touched: string[] = [];
  skip: ReconcileOutcome['skipped'] = [];

  constructor(private readonly mapping: DeviceMapping | null) {}

  findDeviceMapping(): Promise<DeviceMapping | null> {
    return Promise.resolve(this.mapping);
  }

  /** Serials this fake was asked to auto-register, so tests can assert it did NOT happen. */
  autoRegistered: Array<{ deviceSn: string; companyId: string }> = [];
  /** Mapping auto-registration yields; null models a bad DEVICE_DEFAULT_COMPANY_ID. */
  autoRegisterResult: DeviceMapping | null = null;

  autoRegisterDevice(deviceSn: string, companyId: string): Promise<DeviceMapping | null> {
    this.autoRegistered.push({ deviceSn, companyId });
    return Promise.resolve(this.autoRegisterResult);
  }

  findCompanyDefaultProject(): Promise<string | null> {
    return Promise.resolve(null);
  }

  insertPunches(_companyId: string, punches: readonly PunchToStore[]): Promise<number> {
    this.stored.push(...punches);
    return Promise.resolve(punches.length);
  }

  reconcileDays(
    _companyId: string,
    _projectId: string | null,
    days: ReadonlyArray<{ userId: string; attendanceDate: string }>,
  ): Promise<ReconcileOutcome> {
    this.reconciledDays.push(...days);
    return Promise.resolve({ reconciled: days.length - this.skip.length, skipped: this.skip });
  }

  findLatestPunch(): Promise<{ deviceTimestamp: string; receivedAt: Date } | null> {
    return Promise.resolve(null);
  }

  punchDays: Array<{ userId: string; attendanceDate: string }> = [];

  listPunchDays(): Promise<Array<{ userId: string; attendanceDate: string }>> {
    return Promise.resolve(this.punchDays);
  }

  touchDeviceLastSeen(deviceSn: string): Promise<void> {
    this.touched.push(deviceSn);
    return Promise.resolve();
  }
}

describe('DeviceIngestionService', () => {
  const payload = [
    '1042,2026-07-26 09:12:04,0',
    '1042,2026-07-26 18:03:51,1',
    '1043,2026-07-26 09:20:00,0',
  ].join('\n');

  it('stores every punch and reconciles one day per employee', async () => {
    const repo = new FakePunchRepo({ companyId: 'co1', defaultProjectId: 'p1' });
    const svc = new DeviceIngestionService(repo, uow as never, deviceConfigService());

    const result = await svc.ingest(payload, 'ABC123');

    expect(result).toMatchObject({ parsed: 3, stored: 3, reconciled: 2, ignoredLines: 0 });
    // Two punches for 1042 collapse to ONE employee-day, not two.
    expect(repo.reconciledDays).toEqual([
      { userId: '1042', attendanceDate: '2026-07-26' },
      { userId: '1043', attendanceDate: '2026-07-26' },
    ]);
    expect(repo.touched).toEqual(['ABC123']);
  });

  it('DROPS punches from an unregistered device serial instead of guessing a company', async () => {
    const repo = new FakePunchRepo(null);
    const svc = new DeviceIngestionService(repo, uow as never, deviceConfigService());

    const result = await svc.ingest(payload, 'UNKNOWN-SN');

    expect(result.parsed).toBe(3);
    expect(result.stored).toBe(0);
    expect(result.unmappedDeviceSn).toBe('UNKNOWN-SN');
    expect(repo.stored).toHaveLength(0);
  });

  it('is a no-op for an empty or all-garbage payload', async () => {
    const repo = new FakePunchRepo({ companyId: 'co1', defaultProjectId: null });
    const svc = new DeviceIngestionService(repo, uow as never, deviceConfigService());

    expect(await svc.ingest('', 'ABC123')).toMatchObject({ parsed: 0, stored: 0 });
    expect((await svc.ingest('%%%\n###', 'ABC123')).ignoredLines).toBe(2);
    expect(repo.stored).toHaveLength(0);
  });

  it('reports reconciliation skips instead of throwing', async () => {
    const repo = new FakePunchRepo({ companyId: 'co1', defaultProjectId: null });
    repo.skip = [{ userId: '1042', attendanceDate: '2026-07-26', reason: 'NO_PROJECT' }];
    const svc = new DeviceIngestionService(repo, uow as never, deviceConfigService());

    const result = await svc.ingest('1042,2026-07-26 09:12:04,0', 'ABC123');

    expect(result.skipped).toEqual([
      { userId: '1042', attendanceDate: '2026-07-26', reason: 'NO_PROJECT' },
    ]);
  });

  it('re-reconciles stored punches on resync — the retry for days ingestion had to skip', async () => {
    const repo = new FakePunchRepo({ companyId: 'co1', defaultProjectId: 'p1' });
    repo.punchDays = [
      { userId: '1042', attendanceDate: '2026-07-26' },
      { userId: '1043', attendanceDate: '2026-07-26' },
    ];
    const svc = new DeviceIngestionService(repo, uow as never, deviceConfigService());

    const result = await svc.resync('co1', '2026-07-01', '2026-07-31');

    expect(result).toMatchObject({ days: 2, reconciled: 2 });
    expect(repo.reconciledDays).toEqual(repo.punchDays);
  });

  it('resync is a no-op when the window holds no punches', async () => {
    const repo = new FakePunchRepo({ companyId: 'co1', defaultProjectId: 'p1' });
    const svc = new DeviceIngestionService(repo, uow as never, deviceConfigService());

    expect(await svc.resync('co1', '2026-07-01', '2026-07-31')).toEqual({
      days: 0,
      reconciled: 0,
      skipped: [],
    });
    expect(repo.reconciledDays).toHaveLength(0);
  });

  it('parses the timestamp into occurredAt while keeping the raw text', async () => {
    const repo = new FakePunchRepo({ companyId: 'co1', defaultProjectId: 'p1' });
    const svc = new DeviceIngestionService(repo, uow as never, deviceConfigService());

    await svc.ingest('1042,2026-07-26 09:12:04,0', 'ABC123');

    expect(repo.stored[0]?.deviceTimestamp).toBe('2026-07-26 09:12:04');
    expect(repo.stored[0]?.occurredAt?.toISOString()).toBe('2026-07-26T09:12:04.000Z');
  });
});

// ── §7 attendance users ──────────────────────────────────────────────────────────────────────────

class FakeUserRepo implements AttendanceUserRepository {
  rows: AttendanceUserDto[] = [];
  lastDefaults: AttendanceUserCreateDefaults | null = null;

  list(): Promise<AttendanceUserDto[]> {
    return Promise.resolve(this.rows);
  }

  upsert(
    _companyId: string,
    input: UpsertAttendanceUserInput,
    defaults: AttendanceUserCreateDefaults,
  ): Promise<AttendanceUserDto> {
    this.lastDefaults = defaults;
    const existing = this.rows.find((r) => r.userId === input.userId);
    if (existing) {
      existing.name = input.name;
      // Mirrors the SQL COALESCE: undefined leaves the stored designation alone.
      if (input.designation !== undefined) existing.designation = input.designation;
      return Promise.resolve(existing);
    }
    const row: AttendanceUserDto = {
      id: `e${this.rows.length + 1}`,
      userId: input.userId,
      name: input.name,
      designation: input.designation ?? defaults.designation,
      createdAt: new Date('2026-01-04T05:00:00Z'),
      updatedAt: new Date('2026-01-04T05:00:00Z'),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }
}

describe('AttendanceUserService', () => {
  it('creates a user and applies the documented defaults', async () => {
    const repo = new FakeUserRepo();
    const svc = new AttendanceUserService(repo, uow as never);

    const created = await svc.upsert({ userId: '1042', name: 'Karim Rahman' }, ACTOR);

    expect(created).toMatchObject({ userId: '1042', name: 'Karim Rahman' });
    expect(repo.lastDefaults).toMatchObject({ workBase: 'SITE', wageType: 'MONTHLY' });
  });

  it('upserts by userId — the same id twice is one row', async () => {
    const repo = new FakeUserRepo();
    const svc = new AttendanceUserService(repo, uow as never);

    await svc.upsert({ userId: '1042', name: 'Karim' }, ACTOR);
    await svc.upsert({ userId: '1042', name: 'Karim Rahman' }, ACTOR);

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.name).toBe('Karim Rahman');
  });

  it('a partial update does NOT clear an existing designation', async () => {
    const repo = new FakeUserRepo();
    const svc = new AttendanceUserService(repo, uow as never);
    await svc.upsert({ userId: '1042', name: 'Karim', designation: 'Operator' }, ACTOR);

    await svc.upsert({ userId: '1042', name: 'Karim Rahman' }, ACTOR);

    expect(repo.rows[0]?.designation).toBe('Operator');
  });

  it('an explicit null DOES clear the designation', async () => {
    const repo = new FakeUserRepo();
    const svc = new AttendanceUserService(repo, uow as never);
    await svc.upsert({ userId: '1042', name: 'Karim', designation: 'Operator' }, ACTOR);

    await svc.upsert({ userId: '1042', name: 'Karim', designation: null }, ACTOR);

    expect(repo.rows[0]?.designation).toBeNull();
  });

  it('rejects a missing userId, a blank name and a non-string designation', async () => {
    const svc = new AttendanceUserService(new FakeUserRepo(), uow as never);

    await expect(svc.upsert({ name: 'Karim' }, ACTOR)).rejects.toThrow('userId is required');
    await expect(svc.upsert({ userId: '1042', name: '  ' }, ACTOR)).rejects.toThrow(
      'name is required',
    );
    await expect(
      svc.upsert({ userId: '1042', name: 'Karim', designation: 42 }, ACTOR),
    ).rejects.toThrow('designation must be a string or null');
  });
});
