/**
 * DeviceSyncService — the PULL half of ingestion (TRANSFER_PROMPT §3.8).
 *
 * Opens one socket to the device, syncs the roster, then stores punch history. Push
 * (`/iclock/cdata`) remains the real-time path; this backfills history and repairs punches
 * missed while the network or server was down. Both paths converge on the same
 * `checkin_log` → `attendance_record` reconciliation, so the reports cannot disagree.
 *
 * CONCURRENCY: a sync holds a device socket, and two at once makes the firmware drop both.
 * A module-level in-progress flag rejects the second caller with 409 rather than queueing —
 * queueing would just hold an HTTP request open behind a slow device.
 *
 * IDEMPOTENCY: a punch is identified by `(userId, deviceTimestamp)`. The batch is deduped
 * in memory, then `insertPunches` skips anything already stored, so re-running a sync never
 * duplicates history.
 */
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import {
  ATTENDANCE_USER_REPOSITORY,
  type AttendanceUserRepository,
} from '../domain/ports/attendance-user.repository';
import {
  DEVICE_PULLER,
  type DevicePuller,
  type DeviceRosterEntry,
} from '../domain/ports/device-puller.port';
import {
  PUNCH_INGESTION_REPOSITORY,
  type PunchIngestionRepository,
  type PunchToStore,
} from '../domain/ports/punch-ingestion.repository';
import { parseDeviceTimestamp, punchDayKey } from '../domain/punch-payload.parser';

/** Placeholder name for an enrollment the device has no name for. */
const UNKNOWN_NAME = 'Unknown';

/**
 * Defaults for the NOT NULL employee columns a device enrollment cannot supply.
 *
 * `workBase` and `wageType` must match `chk_employee_work_base` / `chk_employee_wage_type`
 * exactly — the device knows neither, and a value outside the enum fails the whole insert,
 * silently costing the entire roster.
 */
const CREATE_DEFAULTS = {
  designation: 'Not set',
  workBase: 'HEAD_OFFICE',
  wageType: 'MONTHLY',
};

export interface SyncSummary {
  users: { fetched: number; created: number; updated: number; unchanged: number; skipped: number };
  attendance: { fetched: number; inserted: number; duplicates: number; skipped: number };
  /** Employees still carrying a placeholder name — these need a manual fix to read well. */
  unnamedUsers: number;
  durationMs: number;
  /** Employee-days folded into `attendance_record` by this sync. */
  reconciled: number;
  /**
   * Why employee-days could not be folded, counted by reason.
   *
   * Without this a sync can report "857 punches stored" while nothing reaches the reports,
   * and the operator has no way to see that every day hit `NO_FINANCIAL_YEAR` or
   * `NO_PROJECT`. Those are fixable data gaps, so they must be visible, not buried in logs.
   */
  skippedReasons: Record<string, number>;
}

/** True for a device-supplied name that carries no information. */
function isPlaceholderName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return trimmed === '' || trimmed === 'unknown';
}

@Injectable()
export class DeviceSyncService {
  private readonly logger = new Logger(DeviceSyncService.name);

  /** Module-level guard — one sync at a time, process-wide. */
  private syncing = false;
  private lastSyncAt: Date | null = null;
  private lastSummary: SyncSummary | null = null;

  constructor(
    @Inject(DEVICE_PULLER) private readonly puller: DevicePuller,
    @Inject(ATTENDANCE_USER_REPOSITORY) private readonly users: AttendanceUserRepository,
    @Inject(PUNCH_INGESTION_REPOSITORY) private readonly punches: PunchIngestionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  isSyncing(): boolean {
    return this.syncing;
  }
  isConfigured(): boolean {
    return this.puller.isConfigured();
  }
  target(): { ip: string; port: number } {
    return this.puller.target();
  }
  lastSync(): { at: Date | null; summary: SyncSummary | null } {
    return { at: this.lastSyncAt, summary: this.lastSummary };
  }

  /**
   * Pull the device and store what it reports.
   *
   * Throws `DeviceNotConfiguredError` (503) / `DeviceUnreachableError` (502) from the puller,
   * and `ConflictException` (409) when a sync is already running.
   */
  async sync(companyId: string, defaultProjectId: string | null): Promise<SyncSummary> {
    if (this.syncing) {
      throw new ConflictException('A device sync is already in progress');
    }
    this.syncing = true;
    const startedAt = Date.now();

    try {
      const { roster, punches } = await this.puller.pull();

      const users = await this.syncRoster(companyId, roster);
      const attendance = await this.storePunches(companyId, defaultProjectId, punches);

      const summary: SyncSummary = {
        users: { fetched: roster.length, ...users.counts },
        attendance: {
          fetched: punches.length,
          inserted: attendance.inserted,
          duplicates: attendance.duplicates,
          skipped: attendance.skipped,
        },
        unnamedUsers: users.unnamed,
        durationMs: Date.now() - startedAt,
        reconciled: attendance.reconciled,
        skippedReasons: attendance.skippedReasons,
      };

      this.lastSyncAt = new Date();
      this.lastSummary = summary;
      this.logger.log(
        `Sync complete in ${summary.durationMs}ms — users +${users.counts.created}/~${users.counts.updated}, ` +
          `punches +${attendance.inserted} (${attendance.duplicates} dup), reconciled ${attendance.reconciled}`,
      );
      return summary;
    } finally {
      // Always release the guard, or one failed sync locks the endpoint until restart.
      this.syncing = false;
    }
  }

  /**
   * Roster sync — the DEVICE is the source of truth for names.
   *
   * A blank device name never overwrites a real stored one: operators fix unnamed
   * enrollments in the portal, and letting the device blank them out again on the next sync
   * would undo that work every time.
   */
  private async syncRoster(
    companyId: string,
    roster: readonly DeviceRosterEntry[],
  ): Promise<{
    counts: { created: number; updated: number; unchanged: number; skipped: number };
    unnamed: number;
  }> {
    const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

    // Later entries win if the device reports a duplicate enrollment number.
    const byUserId = new Map<string, DeviceRosterEntry>();
    for (const entry of roster) {
      if (!entry.userId) {
        counts.skipped += 1;
        continue;
      }
      byUserId.set(entry.userId, entry);
    }

    const existing = new Map(
      (await this.users.list(companyId)).map((u) => [u.userId, u] as const),
    );

    for (const [userId, entry] of byUserId) {
      const stored = existing.get(userId);
      const deviceName = entry.name.trim();

      try {
        if (!stored) {
          // Unknown enrollment: create, using the placeholder when the device has no name.
          await this.users.upsert(
            companyId,
            { userId, name: deviceName || UNKNOWN_NAME },
            CREATE_DEFAULTS,
          );
          counts.created += 1;
          continue;
        }

        // Blank device name, or no change: leave the stored record alone.
        if (!deviceName || deviceName === stored.name) {
          counts.unchanged += 1;
          continue;
        }

        await this.users.upsert(companyId, { userId, name: deviceName }, CREATE_DEFAULTS);
        counts.updated += 1;
      } catch (error) {
        // One bad enrollment must not abort the roster — record it and continue.
        counts.skipped += 1;
        this.logger.warn(
          `Roster entry '${userId}' skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // A handful of skips is normal; skipping the WHOLE roster means something systematic is
    // wrong (a bad create-default failing a check constraint, say) and must be loud — the
    // per-row warnings alone are easy to miss in a 55-entry sync.
    if (counts.skipped > 0 && counts.created === 0 && counts.updated === 0) {
      this.logger.error(
        `Roster sync stored NOTHING: all ${counts.skipped} entr(ies) failed. ` +
          `Check the employee create-defaults against the table's constraints.`,
      );
    }

    const after = await this.users.list(companyId);
    return { counts, unnamed: after.filter((u) => isPlaceholderName(u.name)).length };
  }

  /**
   * Store punches, then fold the touched employee-days into `attendance_record`.
   *
   * `insertPunches` is idempotent on (company, user, timestamp), so the duplicate count is
   * derived from what it actually wrote rather than by pre-querying the table.
   */
  private async storePunches(
    companyId: string,
    defaultProjectId: string | null,
    punches: ReadonlyArray<{ userId: string; deviceTimestamp: string; status: string }>,
  ): Promise<{
    inserted: number;
    duplicates: number;
    skipped: number;
    reconciled: number;
    skippedReasons: Record<string, number>;
  }> {
    if (punches.length === 0) {
      return { inserted: 0, duplicates: 0, skipped: 0, reconciled: 0, skippedReasons: {} };
    }

    // Dedupe within the batch first — the device commonly reports the same punch twice.
    const unique = new Map<string, PunchToStore>();
    let skipped = 0;
    for (const punch of punches) {
      if (!punch.userId || !punch.deviceTimestamp) {
        skipped += 1;
        continue;
      }
      unique.set(`${punch.userId}|${punch.deviceTimestamp}`, {
        sourceType: 'DEVICE_SYNC',
        userId: punch.userId,
        deviceTimestamp: punch.deviceTimestamp,
        status: punch.status || '0',
        occurredAt: parseDeviceTimestamp(punch.deviceTimestamp),
        deviceSn: null,
      });
    }

    const batch = [...unique.values()];
    const days = new Map<string, { userId: string; attendanceDate: string }>();
    for (const punch of batch) {
      const day = punchDayKey(punch.deviceTimestamp);
      if (!day) continue;
      days.set(`${punch.userId}|${day}`, { userId: punch.userId, attendanceDate: day });
    }

    return this.uow.run(async () => {
      const inserted = await this.punches.insertPunches(companyId, batch);
      const outcome = await this.punches.reconcileDays(companyId, defaultProjectId, [
        ...days.values(),
      ]);

      const skippedReasons: Record<string, number> = {};
      for (const entry of outcome.skipped) {
        skippedReasons[entry.reason] = (skippedReasons[entry.reason] ?? 0) + 1;
      }

      // Punches stored but nothing reconciled means the data will not appear in any report.
      // That is the failure mode most likely to be mistaken for "sync worked".
      if (outcome.reconciled === 0 && outcome.skipped.length > 0) {
        this.logger.error(
          `Sync stored punches but reconciled NOTHING — ` +
            `${Object.entries(skippedReasons)
              .map(([reason, n]) => `${reason}×${n}`)
              .join(', ')}. These punches will not appear in attendance reports until fixed.`,
        );
      }

      return {
        inserted,
        duplicates: batch.length - inserted,
        skipped: skipped + outcome.skipped.length,
        reconciled: outcome.reconciled,
        skippedReasons,
      };
    });
  }
}
