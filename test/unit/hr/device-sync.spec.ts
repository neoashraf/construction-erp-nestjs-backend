/**
 * Device PULL sync tests (TRANSFER_PROMPT §3.8) — no device, no DB, no Nest.
 *
 * Covers the rules that are easy to get wrong and impossible to notice in production until
 * data is already corrupt: the SDK's UTC→local wall-clock conversion, firmware field
 * aliasing, roster name precedence, punch idempotency, and the one-sync-at-a-time guard.
 */
import { ConflictException } from '@nestjs/common';
import { DeviceSyncService } from '../../../src/modules/hr/attendance-reports/application/device-sync.service';
import {
  formatLocalWallClock,
  normalisePunchTime,
} from '../../../src/modules/hr/attendance-reports/infrastructure/zk-device-puller.adapter';
import {
  DeviceNotConfiguredError,
  DeviceUnreachableError,
  type DevicePullResult,
  type DevicePuller,
} from '../../../src/modules/hr/attendance-reports/domain/ports/device-puller.port';
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

const uow = { run: <T>(fn: () => Promise<T> | T): Promise<T> => Promise.resolve(fn()) };

// ── timestamp normalisation ──────────────────────────────────────────────────────────────────────

describe('normalisePunchTime', () => {
  it('keeps a zone-less wall-clock string VERBATIM', () => {
    // Reparsing this as UTC would shift it by the server offset and break dedupe against
    // the same punch arriving via push.
    expect(normalisePunchTime('2026-07-09 09:15:00')).toBe('2026-07-09 09:15:00');
  });

  it('pads a missing seconds field', () => {
    expect(normalisePunchTime('2026-07-09 09:15')).toBe('2026-07-09 09:15:00');
  });

  it('converts a real UTC instant into server-local wall clock', () => {
    // The SDK returns instants; push sends local text. Both must land in one representation.
    const utc = new Date('2026-07-09T08:01:36.000Z');
    expect(normalisePunchTime(utc)).toBe(formatLocalWallClock(utc));
    expect(normalisePunchTime(utc)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('returns null for junk rather than an Invalid Date', () => {
    expect(normalisePunchTime('nonsense')).toBeNull();
    expect(normalisePunchTime(null)).toBeNull();
    expect(normalisePunchTime('')).toBeNull();
  });
});

// ── fakes ────────────────────────────────────────────────────────────────────────────────────────

class FakePuller implements DevicePuller {
  calls = 0;
  constructor(
    private readonly result: DevicePullResult,
    private readonly configured = true,
    private readonly failWith?: Error,
  ) {}
  isConfigured() {
    return this.configured;
  }
  target() {
    return { ip: '192.168.0.201', port: 4370 };
  }
  async pull(): Promise<DevicePullResult> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    return this.result;
  }
}

class FakeUserRepo implements AttendanceUserRepository {
  rows: AttendanceUserDto[] = [];
  constructor(seed: Array<{ userId: string; name: string }> = []) {
    this.rows = seed.map((s, i) => ({
      id: `e${i}`,
      userId: s.userId,
      name: s.name,
      designation: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  }
  list(): Promise<AttendanceUserDto[]> {
    return Promise.resolve([...this.rows]);
  }
  upsert(
    _companyId: string,
    input: UpsertAttendanceUserInput,
    _defaults: AttendanceUserCreateDefaults,
  ): Promise<AttendanceUserDto> {
    const found = this.rows.find((r) => r.userId === input.userId);
    if (found) {
      found.name = input.name;
      return Promise.resolve(found);
    }
    const created: AttendanceUserDto = {
      id: `e${this.rows.length}`,
      userId: input.userId,
      name: input.name,
      designation: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(created);
    return Promise.resolve(created);
  }
}

class FakePunchRepo implements PunchIngestionRepository {
  stored: PunchToStore[] = [];
  /** Keys already "in the database", so a replay counts as a duplicate. */
  existing = new Set<string>();

  findDeviceMapping(): Promise<DeviceMapping | null> {
    return Promise.resolve({ companyId: 'co1', defaultProjectId: 'p1' });
  }
  autoRegisterDevice(): Promise<DeviceMapping | null> {
    return Promise.resolve(null);
  }
  findCompanyDefaultProject(): Promise<string | null> {
    return Promise.resolve('p1');
  }
  insertPunches(_companyId: string, punches: readonly PunchToStore[]): Promise<number> {
    let inserted = 0;
    for (const p of punches) {
      const key = `${p.userId}|${p.deviceTimestamp}`;
      if (this.existing.has(key)) continue; // ON CONFLICT DO NOTHING
      this.existing.add(key);
      this.stored.push(p);
      inserted += 1;
    }
    return Promise.resolve(inserted);
  }
  reconcileDays(
    _companyId: string,
    _projectId: string | null,
    days: ReadonlyArray<{ userId: string; attendanceDate: string }>,
  ): Promise<ReconcileOutcome> {
    return Promise.resolve({ reconciled: days.length, skipped: [] });
  }
  findLatestPunch(): Promise<{ deviceTimestamp: string; receivedAt: Date } | null> {
    return Promise.resolve(null);
  }
  listPunchDays(): Promise<Array<{ userId: string; attendanceDate: string }>> {
    return Promise.resolve([]);
  }
  touchDeviceLastSeen(): Promise<void> {
    return Promise.resolve();
  }
}

function makeService(pull: DevicePullResult, users = new FakeUserRepo(), punches = new FakePunchRepo()) {
  const puller = new FakePuller(pull);
  const svc = new DeviceSyncService(puller, users, punches, uow as never);
  return { svc, puller, users, punches };
}

// ── roster ───────────────────────────────────────────────────────────────────────────────────────

describe('DeviceSyncService — roster', () => {
  it('creates unknown enrollments and counts them', async () => {
    const { svc, users } = makeService({
      roster: [
        { userId: '1001', name: 'Rahim Uddin' },
        { userId: '1002', name: 'Karim' },
      ],
      punches: [],
    });

    const summary = await svc.sync('co1', 'p1');

    expect(summary.users.fetched).toBe(2);
    expect(summary.users.created).toBe(2);
    expect(users.rows.map((r) => r.name)).toEqual(['Rahim Uddin', 'Karim']);
  });

  it('names an unnamed enrollment "Unknown" and reports the count', async () => {
    const { svc } = makeService({ roster: [{ userId: '1001', name: '  ' }], punches: [] });

    const summary = await svc.sync('co1', 'p1');

    expect(summary.users.created).toBe(1);
    expect(summary.unnamedUsers).toBe(1);
  });

  it('updates a changed name — the device is the source of truth', async () => {
    const users = new FakeUserRepo([{ userId: '1001', name: 'Old Name' }]);
    const { svc } = makeService({ roster: [{ userId: '1001', name: 'New Name' }], punches: [] }, users);

    const summary = await svc.sync('co1', 'p1');

    expect(summary.users.updated).toBe(1);
    expect(users.rows[0]!.name).toBe('New Name');
  });

  it('never lets a BLANK device name wipe a real stored name', async () => {
    // Operators fix unnamed enrollments in the portal; a blank from the device must not
    // undo that on the next sync.
    const users = new FakeUserRepo([{ userId: '1001', name: 'Rahim Uddin' }]);
    const { svc } = makeService({ roster: [{ userId: '1001', name: '' }], punches: [] }, users);

    const summary = await svc.sync('co1', 'p1');

    expect(summary.users.unchanged).toBe(1);
    expect(summary.users.updated).toBe(0);
    expect(users.rows[0]!.name).toBe('Rahim Uddin');
  });

  it('lets a later duplicate enrollment win', async () => {
    const { svc, users } = makeService({
      roster: [
        { userId: '1001', name: 'First' },
        { userId: '1001', name: 'Second' },
      ],
      punches: [],
    });

    await svc.sync('co1', 'p1');
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]!.name).toBe('Second');
  });
});

// ── punches ──────────────────────────────────────────────────────────────────────────────────────

describe('DeviceSyncService — punches', () => {
  const pull: DevicePullResult = {
    roster: [{ userId: '1001', name: 'Rahim' }],
    punches: [
      { userId: '1001', deviceTimestamp: '2026-07-20 09:12:00', status: '0' },
      { userId: '1001', deviceTimestamp: '2026-07-20 18:05:00', status: '1' },
    ],
  };

  it('stores punches and folds them into ONE employee-day', async () => {
    const { svc } = makeService(pull);
    const summary = await svc.sync('co1', 'p1');

    expect(summary.attendance.fetched).toBe(2);
    expect(summary.attendance.inserted).toBe(2);
    // Two punches, same person, same date → one reconciled day.
    expect(summary.reconciled).toBe(1);
  });

  it('is IDEMPOTENT — syncing the same batch twice inserts once', async () => {
    const punches = new FakePunchRepo();
    const { svc } = makeService(pull, new FakeUserRepo(), punches);

    const first = await svc.sync('co1', 'p1');
    const second = await svc.sync('co1', 'p1');

    expect(first.attendance.inserted).toBe(2);
    expect(second.attendance.inserted).toBe(0);
    expect(second.attendance.duplicates).toBe(2);
    expect(punches.stored).toHaveLength(2);
  });

  it('dedupes repeats WITHIN one batch before writing', async () => {
    const punches = new FakePunchRepo();
    const { svc } = makeService(
      {
        roster: [],
        punches: [
          { userId: '1001', deviceTimestamp: '2026-07-20 09:12:00', status: '0' },
          { userId: '1001', deviceTimestamp: '2026-07-20 09:12:00', status: '0' },
        ],
      },
      new FakeUserRepo(),
      punches,
    );

    const summary = await svc.sync('co1', 'p1');
    expect(summary.attendance.fetched).toBe(2);
    expect(punches.stored).toHaveLength(1);
  });

  it('tags stored punches as DEVICE_SYNC so the ingestion path is traceable', async () => {
    const punches = new FakePunchRepo();
    const { svc } = makeService(pull, new FakeUserRepo(), punches);
    await svc.sync('co1', 'p1');
    expect(punches.stored.every((p) => p.sourceType === 'DEVICE_SYNC')).toBe(true);
  });
});

// ── concurrency & failure ────────────────────────────────────────────────────────────────────────

describe('DeviceSyncService — guards', () => {
  it('rejects a concurrent sync with 409 rather than opening a second socket', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowPuller: DevicePuller = {
      isConfigured: () => true,
      target: () => ({ ip: '1.2.3.4', port: 4370 }),
      pull: async () => {
        await gate;
        return { roster: [], punches: [] };
      },
    };
    const svc = new DeviceSyncService(slowPuller, new FakeUserRepo(), new FakePunchRepo(), uow as never);

    const first = svc.sync('co1', 'p1');
    await expect(svc.sync('co1', 'p1')).rejects.toBeInstanceOf(ConflictException);

    release();
    await first;
    // Guard released, so a later sync succeeds.
    await expect(svc.sync('co1', 'p1')).resolves.toBeDefined();
  });

  it('releases the guard even when the pull throws', async () => {
    const failing: DevicePuller = {
      isConfigured: () => true,
      target: () => ({ ip: '1.2.3.4', port: 4370 }),
      pull: () => Promise.reject(new DeviceUnreachableError('1.2.3.4:4370')),
    };
    const svc = new DeviceSyncService(failing, new FakeUserRepo(), new FakePunchRepo(), uow as never);

    await expect(svc.sync('co1', 'p1')).rejects.toBeInstanceOf(DeviceUnreachableError);
    // A failed sync must not lock the endpoint until restart.
    expect(svc.isSyncing()).toBe(false);
  });

  it('surfaces the not-configured error so the route can answer 503', async () => {
    const unconfigured: DevicePuller = {
      isConfigured: () => false,
      target: () => ({ ip: '', port: 4370 }),
      pull: () => Promise.reject(new DeviceNotConfiguredError()),
    };
    const svc = new DeviceSyncService(unconfigured, new FakeUserRepo(), new FakePunchRepo(), uow as never);

    expect(svc.isConfigured()).toBe(false);
    await expect(svc.sync('co1', 'p1')).rejects.toBeInstanceOf(DeviceNotConfiguredError);
  });

  it('records the last sync for the status endpoint', async () => {
    const { svc } = makeService({ roster: [], punches: [] });
    expect(svc.lastSync().at).toBeNull();

    await svc.sync('co1', 'p1');

    const { at, summary } = svc.lastSync();
    expect(at).toBeInstanceOf(Date);
    expect(summary?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
