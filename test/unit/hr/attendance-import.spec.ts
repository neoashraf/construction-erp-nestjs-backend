/**
 * Attendance spreadsheet import — the pure row parser plus the service that puts the
 * resulting punches on the shared ingestion rail.
 *
 * The behaviour worth protecting is that an import is INDISTINGUISHABLE from a device punch
 * once stored, and that re-running one is a no-op. Both properties come from reusing
 * `insertPunches` / `reconcileDays`, so the service tests assert on what it hands that
 * repository rather than on any storage of its own.
 */
import { AttendanceImportService } from '../../../src/modules/hr/attendance-reports/application/attendance-import.service';
import { parseImportRows } from '../../../src/modules/hr/attendance-reports/domain/attendance-import.parser';
import type {
  PunchIngestionRepository,
  PunchToStore,
} from '../../../src/modules/hr/attendance-reports/domain/ports/punch-ingestion.repository';
import { ReportBadRequestError } from '../../../src/modules/hr/attendance-reports/domain/attendance-rules';

describe('parseImportRows', () => {
  it('expands one day row into a check-in and a check-out punch', () => {
    const result = parseImportRows([
      { userId: '1001', date: '2026-07-01', checkIn: '09:05', checkOut: '18:10' },
    ]);

    expect(result.punches).toEqual([
      { userId: '1001', deviceTimestamp: '2026-07-01 09:05:00', status: '0', location: null, row: 2 },
      { userId: '1001', deviceTimestamp: '2026-07-01 18:10:00', status: '1', location: null, row: 2 },
    ]);
    expect(result.acceptedRows).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('pads a bare HH:mm and accepts explicit seconds', () => {
    const result = parseImportRows([
      { userId: '7', date: '2026-07-01', checkIn: '9:05', checkOut: '18:10:42' },
    ]);
    expect(result.punches.map((p) => p.deviceTimestamp)).toEqual([
      '2026-07-01 09:05:00',
      '2026-07-01 18:10:42',
    ]);
  });

  it('accepts a row with only a check-in', () => {
    const result = parseImportRows([{ userId: '7', date: '2026-07-01', checkIn: '09:05' }]);
    expect(result.punches).toHaveLength(1);
    expect(result.punches[0]?.status).toBe('0');
  });

  it('does not emit a second punch when check-out equals check-in', () => {
    // The same event written into both columns. Two identical punches would collide on the
    // storage key anyway, so counting them separately would only misreport the totals.
    const result = parseImportRows([
      { userId: '7', date: '2026-07-01', checkIn: '09:05', checkOut: '09:05' },
    ]);
    expect(result.punches).toHaveLength(1);
    expect(result.acceptedRows).toBe(1);
  });

  it('skips entirely blank rows in silence', () => {
    const result = parseImportRows([
      { userId: '', date: '', checkIn: '', checkOut: '' },
      { userId: '7', date: '2026-07-01', checkIn: '09:05' },
    ]);
    expect(result.blankRows).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.acceptedRows).toBe(1);
  });

  it('reports the sheet row number, counting the header as row 1', () => {
    const result = parseImportRows([
      { userId: '7', date: '2026-07-01', checkIn: '09:05' },
      { userId: '', date: '2026-07-02', checkIn: '09:05' },
    ]);
    // Data index 1 is what the user sees as row 3.
    expect(result.errors).toEqual([{ row: 3, message: 'Employee ID is required' }]);
  });

  it('keeps good rows when other rows fail', () => {
    // A 500-row month with three typos must import 497 rows, not zero — otherwise the
    // operator has to bisect the file to find the bad row.
    const result = parseImportRows([
      { userId: '1', date: '2026-07-01', checkIn: '09:05' },
      { userId: '2', date: 'not-a-date', checkIn: '09:05' },
      { userId: '3', date: '2026-07-01', checkIn: '09:05' },
    ]);
    expect(result.acceptedRows).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.row).toBe(3);
  });

  it('rejects a date that matches the format but is not a real day', () => {
    const result = parseImportRows([{ userId: '7', date: '2026-02-31', checkIn: '09:05' }]);
    expect(result.punches).toEqual([]);
    expect(result.errors[0]?.message).toContain('2026-02-31');
  });

  it('rejects a row carrying a date but no times', () => {
    // Absence is the absence of punches; a timeless row would create a phantom present-day.
    const result = parseImportRows([{ userId: '7', date: '2026-07-01' }]);
    expect(result.errors[0]?.message).toContain('Check In');
  });

  it('rejects a check-out earlier than its check-in', () => {
    // MIN/MAX reconciliation would silently swap them, so the day would read as 09:00 out.
    const result = parseImportRows([
      { userId: '7', date: '2026-07-01', checkIn: '18:00', checkOut: '09:00' },
    ]);
    expect(result.punches).toEqual([]);
    expect(result.errors[0]?.message).toContain('before check-in');
  });

  it('carries the location cell onto every punch the row produces, trimmed but unresolved', () => {
    // Trimmed because a stray space in a spreadsheet cell is never meant; UNRESOLVED because
    // turning it into a project id needs the database, and the parser is pure.
    const result = parseImportRows([
      { userId: 'E1', date: '2026-07-10', checkIn: '09:00', checkOut: '18:00', location: ' BRIDGE-04 ' },
    ]);

    expect(result.punches.map((p) => p.location)).toEqual(['BRIDGE-04', 'BRIDGE-04']);
    expect(result.errors).toEqual([]);
  });

  it('treats a blank location as NOT STATED, so existing sheets import unchanged', () => {
    const result = parseImportRows([
      { userId: 'E2', date: '2026-07-10', checkIn: '09:05', location: '' },
      { userId: 'E3', date: '2026-07-10', checkIn: '09:06' },
    ]);

    expect(result.punches[0]?.location).toBeNull();
    expect(result.punches[1]?.location).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it('surfaces a row carrying ONLY a location rather than silently skipping it as blank', () => {
    const result = parseImportRows([{ location: 'BRIDGE-04' }]);

    expect(result.blankRows).toBe(0);
    expect(result.errors).toEqual([{ row: 2, message: 'Employee ID is required' }]);
  });

  it('rejects out-of-range clock values', () => {
    expect(parseImportRows([{ userId: '7', date: '2026-07-01', checkIn: '25:00' }]).errors).toHaveLength(1);
    expect(parseImportRows([{ userId: '7', date: '2026-07-01', checkIn: '09:75' }]).errors).toHaveLength(1);
  });
});

describe('AttendanceImportService', () => {
  function repo(overrides: Partial<PunchIngestionRepository> = {}) {
    return {
      findDeviceMapping: jest.fn().mockResolvedValue(null),
      autoRegisterDevice: jest.fn().mockResolvedValue(null),
      findCompanyDefaultProject: jest.fn().mockResolvedValue(null),
      resolveProjectsByLocation: jest.fn().mockResolvedValue(new Map()),
      insertPunches: jest.fn().mockResolvedValue(0),
      reconcileDays: jest.fn().mockResolvedValue({ reconciled: 0, skipped: [] }),
      findLatestPunch: jest.fn().mockResolvedValue(null),
      listPunchDays: jest.fn().mockResolvedValue([]),
      touchDeviceLastSeen: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as jest.Mocked<PunchIngestionRepository>;
  }

  const uow = { run: <T>(fn: () => Promise<T>) => fn() };

  function service(repository: jest.Mocked<PunchIngestionRepository>) {
    return new AttendanceImportService(repository, uow as never);
  }

  const ROW = { userId: '1001', date: '2026-07-01', checkIn: '09:05', checkOut: '18:10' };

  it('stores punches through the shared ingestion repository', async () => {
    const repository = repo({
      insertPunches: jest.fn().mockResolvedValue(2),
      reconcileDays: jest.fn().mockResolvedValue({ reconciled: 1, skipped: [] }),
    });

    const result = await service(repository).import('co-1', 'proj-1', [ROW]);

    const [companyId, punches] = repository.insertPunches.mock.calls[0] as [string, PunchToStore[]];
    expect(companyId).toBe('co-1');
    expect(punches).toHaveLength(2);
    // Tagged as import-sourced, but otherwise identical to a device punch — that is what
    // lets reconciliation treat both the same.
    expect(punches.every((p) => p.sourceType === 'EXCEL_IMPORT')).toBe(true);
    expect(punches.every((p) => p.deviceSn === null)).toBe(true);
    expect(result.inserted).toBe(2);
    expect(result.reconciled).toBe(1);
  });

  it('reconciles each touched employee-day exactly once', async () => {
    const repository = repo({ insertPunches: jest.fn().mockResolvedValue(4) });

    await service(repository).import('co-1', 'proj-1', [
      ROW,
      { userId: '1001', date: '2026-07-02', checkIn: '09:00', checkOut: '18:00' },
    ]);

    const [, , days] = repository.reconcileDays.mock.calls[0] as [string, string, unknown[]];
    // Two rows × two punches = four punches, but only two DAYS to fold.
    expect(days).toEqual([
      { userId: '1001', attendanceDate: '2026-07-01' },
      { userId: '1001', attendanceDate: '2026-07-02' },
    ]);
  });

  it('passes the default project through so employees without one are not skipped', async () => {
    const repository = repo();
    await service(repository).import('co-1', 'proj-fallback', [ROW]);
    expect(repository.reconcileDays).toHaveBeenCalledWith('co-1', 'proj-fallback', expect.anything());
  });

  it('reports a re-import as duplicates rather than doubling history', async () => {
    // insertPunches is idempotent on (company, user, timestamp): the second run writes nothing.
    const repository = repo({
      insertPunches: jest.fn().mockResolvedValue(0),
      reconcileDays: jest.fn().mockResolvedValue({ reconciled: 1, skipped: [] }),
    });

    const result = await service(repository).import('co-1', 'proj-1', [ROW]);

    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(2);
    expect(result.punches).toBe(2);
  });

  it('collapses a punch listed twice in one file before touching the database', async () => {
    const repository = repo();
    await service(repository).import('co-1', 'proj-1', [ROW, { ...ROW }]);

    const [, punches] = repository.insertPunches.mock.calls[0] as [string, PunchToStore[]];
    expect(punches).toHaveLength(2); // not 4
  });

  it('surfaces why days could not reach the reports', async () => {
    const repository = repo({
      insertPunches: jest.fn().mockResolvedValue(2),
      reconcileDays: jest.fn().mockResolvedValue({
        reconciled: 0,
        skipped: [
          { userId: '1001', attendanceDate: '2026-07-01', reason: 'NO_FINANCIAL_YEAR' },
          { userId: '1002', attendanceDate: '2026-07-01', reason: 'NO_FINANCIAL_YEAR' },
          { userId: '1003', attendanceDate: '2026-07-01', reason: 'NO_PROJECT' },
        ],
      }),
    });

    const result = await service(repository).import('co-1', null, [ROW]);

    // Without this the import reports "2 punches stored" while every report stays empty.
    expect(result.skippedReasons).toEqual({ NO_FINANCIAL_YEAR: 2, NO_PROJECT: 1 });
    expect(result.reconciled).toBe(0);
  });

  it('returns the row errors without writing when nothing validates', async () => {
    const repository = repo();
    const result = await service(repository).import('co-1', 'proj-1', [
      { userId: '', date: 'nope', checkIn: '' },
    ]);

    expect(repository.insertPunches).not.toHaveBeenCalled();
    expect(result.acceptedRows).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  it('resolves a stated location to rank 1 of the resolution order', async () => {
    // Without this a branch office importing its written entry log has EVERY row costed to
    // whatever the company default happens to be — head-office overhead.
    const repository = repo({
      resolveProjectsByLocation: jest.fn().mockResolvedValue(new Map([['bridge-04', 'proj-bridge']])),
      insertPunches: jest.fn().mockResolvedValue(2),
    });

    await service(repository).import('co-1', 'proj-default', [
      { userId: '1001', date: '2026-07-01', checkIn: '09:05', location: 'Bridge-04' },
    ]);

    const [, punches] = repository.insertPunches.mock.calls[0] as [string, PunchToStore[]];
    expect(punches[0]?.projectId).toBe('proj-bridge');
  });

  it('leaves projectId null when no location is stated, exactly as before the column existed', async () => {
    const repository = repo({ insertPunches: jest.fn().mockResolvedValue(2) });

    await service(repository).import('co-1', 'proj-default', [ROW]);

    const [, punches] = repository.insertPunches.mock.calls[0] as [string, PunchToStore[]];
    expect(punches.every((p) => p.projectId === null)).toBe(true);
    // The default still travels separately, so employees without a project are not skipped.
    expect(repository.reconcileDays).toHaveBeenCalledWith('co-1', 'proj-default', expect.anything());
  });

  it('reports an unresolvable location per row and still imports the rest of the file', async () => {
    const repository = repo({
      resolveProjectsByLocation: jest.fn().mockResolvedValue(new Map([['ho-ovh', 'proj-ho']])),
      insertPunches: jest.fn().mockResolvedValue(2),
    });

    const result = await service(repository).import('co-1', null, [
      { userId: '1001', date: '2026-07-01', checkIn: '09:05', location: 'HO-OVH' },
      { userId: '1002', date: '2026-07-01', checkIn: '09:06', location: 'Nowhere' },
      { userId: '1003', date: '2026-07-01', checkIn: '09:07', location: 'ho-ovh' },
    ]);

    // The bad cell is named by its SHEET row, like a bad date — not a 400 for the whole file.
    expect(result.errors).toEqual([
      { row: 3, message: "Unknown location 'Nowhere' — expected a project code or name" },
    ]);
    expect(result.acceptedRows).toBe(2);

    const [, punches] = repository.insertPunches.mock.calls[0] as [string, PunchToStore[]];
    expect(punches).toHaveLength(2); // the rejected row contributed nothing
    expect(punches.every((p) => p.projectId === 'proj-ho')).toBe(true); // matching is case-insensitive
  });

  it('rejects an empty payload and an oversized one', async () => {
    const repository = repo();
    await expect(service(repository).import('co-1', null, [])).rejects.toBeInstanceOf(
      ReportBadRequestError,
    );

    const huge = Array.from({ length: 20_001 }, () => ROW);
    await expect(service(repository).import('co-1', null, huge)).rejects.toBeInstanceOf(
      ReportBadRequestError,
    );
  });
});
