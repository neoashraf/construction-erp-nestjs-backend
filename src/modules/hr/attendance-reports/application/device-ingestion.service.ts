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
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import {
  parseAttendancePayload,
  parseDeviceTimestamp,
  punchDayKey,
} from '../domain/punch-payload.parser';
import {
  PUNCH_INGESTION_REPOSITORY,
  PunchIngestionRepository,
  PunchToStore,
  ReconcileOutcome,
} from '../domain/ports/punch-ingestion.repository';

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

  constructor(
    @Inject(PUNCH_INGESTION_REPOSITORY) private readonly repo: PunchIngestionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

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

    const mapping = await this.repo.findDeviceMapping(deviceSn);
    if (!mapping) {
      this.logger.error(
        `Device serial '${deviceSn ?? 'unknown'}' is not registered in attendance_device — ` +
          `${records.length} punch(es) dropped. Register the device to attribute them to a company.`,
      );
      return {
        ...EMPTY,
        parsed: records.length,
        ignoredLines: ignoredLines.length,
        unmappedDeviceSn: deviceSn,
      };
    }

    const punches: PunchToStore[] = records.map((record) => ({
      sourceType: record.type,
      userId: String(record.userId),
      deviceTimestamp: String(record.timestamp),
      status: String(record.status),
      occurredAt: parseDeviceTimestamp(String(record.timestamp)),
      deviceSn,
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
}
