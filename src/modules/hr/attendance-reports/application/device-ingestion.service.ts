/**
 * DeviceIngestionService — the ONLY path device punches enter the system (SUPPORTING_APIS_GUIDE §5).
 * Parses the raw payload, appends to `checkin_log`, then reconciles each touched employee-day into the
 * OFFICE `attendance_record` row the reports read.
 *
 * TENANCY: the device knows nothing about companies, so the company is resolved from the serial number
 * (`?SN=…`) via the `attendance_device` table. An UNREGISTERED serial is not guessed at — the punches
 * are dropped and the fact is logged. Registering a device is an explicit admin act; silently attributing
 * punches to "the first company we found" would be a cross-tenant data leak.
 *
 * FAILURE POSTURE: this endpoint always answers the device with `OK` (the controller enforces that), so
 * everything here is written to be non-throwing from the device's point of view. A parse failure on one
 * line drops that line, not the batch; a reconciliation skip is reported, not raised.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDeviceConfig, type DeviceConfig } from '../../../../config/app-config';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import {
  parseAttendancePayload,
  parseDeviceTimestamp,
  punchDayKey,
} from '../domain/punch-payload.parser';
import {
  DeviceMapping,
  PUNCH_INGESTION_REPOSITORY,
  PunchIngestionRepository,
  PunchToStore,
  ReconcileOutcome,
} from '../domain/ports/punch-ingestion.repository';

/** Marks these punches as pushed-by-the-machine in `checkin_log.source_type` (`/iclock/cdata`). */
const SOURCE_TYPE = 'DEVICE_PUSH';

export interface IngestResult {
  parsed: number;
  stored: number;
  ignoredLines: number;
  reconciled: number;
  skipped: ReconcileOutcome['skipped'];
  /** Set when the serial is not registered — nothing was stored. */
  unmappedDeviceSn?: string | null;
}

const EMPTY: IngestResult = {
  parsed: 0,
  stored: 0,
  ignoredLines: 0,
  reconciled: 0,
  skipped: [],
};

@Injectable()
export class DeviceIngestionService {
  private readonly logger = new Logger(DeviceIngestionService.name);

  private readonly deviceConfig: DeviceConfig;

  constructor(
    @Inject(PUNCH_INGESTION_REPOSITORY) private readonly repo: PunchIngestionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ConfigService) configService: ConfigService,
  ) {
    this.deviceConfig = getDeviceConfig(configService);
  }

  /**
   * Resolve the tenant for a serial, auto-registering a first-contact device when — and only
   * when — `DEVICE_DEFAULT_COMPANY_ID` names one explicitly.
   *
   * Unregistered serials were previously dropped outright. That is the right *security*
   * default (attributing punches to a guessed company is a cross-tenant leak) but it loses
   * real attendance silently, since the endpoint must still answer the device `OK`. An
   * explicitly configured company resolves both: nothing is guessed, and nothing is lost
   * while a device is being commissioned. Every auto-registration is logged as a warning so
   * the operator still assigns the correct company/project afterwards.
   */
  private async resolveMapping(
    deviceSn: string | null,
    punchCount: number,
  ): Promise<DeviceMapping | null> {
    const existing = await this.repo.findDeviceMapping(deviceSn);
    if (existing) return existing;

    const fallbackCompanyId = this.deviceConfig.defaultCompanyId.trim();
    if (!deviceSn || !fallbackCompanyId) {
      this.logger.error(
        `Device serial '${deviceSn ?? 'unknown'}' is not registered in attendance_device — ` +
          `${punchCount} punch(es) dropped. Register the device, or set ` +
          `DEVICE_DEFAULT_COMPANY_ID to auto-register first-contact devices.`,
      );
      return null;
    }

    const registered = await this.repo.autoRegisterDevice(deviceSn, fallbackCompanyId);
    if (!registered) {
      this.logger.error(
        `Device serial '${deviceSn}' is unregistered and DEVICE_DEFAULT_COMPANY_ID ` +
          `'${fallbackCompanyId}' does not match a company — ${punchCount} punch(es) dropped.`,
      );
      return null;
    }

    this.logger.warn(
      `Device serial '${deviceSn}' auto-registered to company ${fallbackCompanyId}. ` +
        `Assign its company and default project in the portal — punches are being attributed ` +
        `to the configured fallback until then.`,
    );
    return registered;
  }

  /**
   * The default project a pull-sync should attribute punches to.
   *
   * A pull has no serial to resolve (we dialled the device, it didn't announce itself), so the
   * project comes from any registered device row for the company. Null is acceptable —
   * reconciliation then falls back to the employee's own default project and reports
   * `NO_PROJECT` for anyone lacking one.
   */
  async findDefaultProject(companyId: string): Promise<string | null> {
    return this.repo.findCompanyDefaultProject(companyId);
  }

  async ingest(rawBody: string, deviceSn: string | null): Promise<IngestResult> {
    const { records, ignoredLines } = parseAttendancePayload(rawBody);

    if (ignoredLines.length > 0) {
      // Logged, not thrown: a corrupt line must never cost the rest of the batch.
      this.logger.warn(
        `Device ${deviceSn ?? 'unknown'}: ignored ${ignoredLines.length} unparseable line(s)`,
      );
    }
    if (records.length === 0) {
      return { ...EMPTY, ignoredLines: ignoredLines.length };
    }

    const mapping = await this.resolveMapping(deviceSn, records.length);
    if (!mapping) {
      return {
        ...EMPTY,
        parsed: records.length,
        ignoredLines: ignoredLines.length,
        unmappedDeviceSn: deviceSn,
      };
    }

    const punches: PunchToStore[] = records.map((record) => ({
      // `record.type` is the WIRE FORMAT the line arrived in (ATTLOG / TAB / CSV), not a provenance.
      // Storing it made `source_type` mean two different things depending on how the device framed
      // its payload; the four stored values are exactly DEVICE_PUSH · DEVICE_SYNC · EXCEL_IMPORT ·
      // MANUAL, and every push is a push regardless of framing.
      sourceType: SOURCE_TYPE,
      userId: String(record.userId),
      deviceTimestamp: String(record.timestamp),
      status: String(record.status),
      occurredAt: parseDeviceTimestamp(String(record.timestamp)),
      deviceSn,
      // A machine knows only itself, never a project — the device row supplies the fallback.
      projectId: null,
    }));

    // The (employee, day) pairs this batch touched — only these need re-folding.
    const days = new Map<string, { userId: string; attendanceDate: string }>();
    for (const punch of punches) {
      const day = punchDayKey(punch.deviceTimestamp);
      if (!day) continue;
      days.set(`${punch.userId}|${day}`, { userId: punch.userId, attendanceDate: day });
    }

    return this.uow.run(async () => {
      const stored = await this.repo.insertPunches(mapping.companyId, punches);
      const outcome = await this.repo.reconcileDays(
        mapping.companyId,
        mapping.defaultProjectId,
        [...days.values()],
      );
      if (deviceSn) await this.repo.touchDeviceLastSeen(deviceSn, new Date());

      if (outcome.skipped.length > 0) {
        this.logger.warn(
          `Device ${deviceSn ?? 'unknown'}: ${outcome.skipped.length} employee-day(s) not reconciled ` +
            `(${[...new Set(outcome.skipped.map((s) => s.reason))].join(', ')})`,
        );
      }

      return {
        parsed: records.length,
        stored,
        ignoredLines: ignoredLines.length,
        reconciled: outcome.reconciled,
        skipped: outcome.skipped,
      };
    });
  }

  findLatestPunch(companyId: string): Promise<{ deviceTimestamp: string; receivedAt: Date } | null> {
    return this.repo.findLatestPunch(companyId);
  }

  /**
   * Stamp `last_seen_at` from a handshake/poll — contact, not punches.
   *
   * Fire-and-forget by design: this runs on the device-facing hot path, which must answer fast
   * and must never fail because of a bookkeeping write. A lost stamp only delays the liveness
   * badge by one poll.
   */
  async touchLastSeen(deviceSn: string): Promise<void> {
    try {
      await this.repo.touchDeviceLastSeen(deviceSn, new Date());
    } catch (error) {
      this.logger.debug(
        `Could not stamp last_seen for '${deviceSn}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Manual re-reconcile (`POST /api/sync`). In a PUSH architecture there is nothing to pull from the
   * device — punches are already here — so the useful "sync" is re-folding stored punches into
   * `attendance_record`.
   *
   * That is not a no-op: reconciliation at ingest time SKIPS days it cannot place (unknown employee
   * code, no project on the employee or device, no financial year covering the date). Once an admin
   * fixes the underlying data, those punches are still sitting in `checkin_log` with nothing to trigger
   * a retry. This is that trigger.
   *
   * Idempotent — re-folding a day it already folded writes the same first/last punch back.
   */
  async resync(
    companyId: string,
    dateFrom: string,
    dateTo: string,
    defaultProjectId: string | null = null,
  ): Promise<{ days: number; reconciled: number; skipped: ReconcileOutcome['skipped'] }> {
    const days = await this.repo.listPunchDays(companyId, dateFrom, dateTo);
    if (days.length === 0) return { days: 0, reconciled: 0, skipped: [] };

    return this.uow.run(async () => {
      const outcome = await this.repo.reconcileDays(companyId, defaultProjectId, days);
      return { days: days.length, reconciled: outcome.reconciled, skipped: outcome.skipped };
    });
  }
}
