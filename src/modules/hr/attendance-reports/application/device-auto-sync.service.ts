/**
 * DeviceAutoSyncService — unattended PULL on a timer.
 *
 * WHY THIS EXISTS: push (`/iclock/cdata`) is the real-time path in theory, but a ZKTeco unit only
 * pushes when its firmware is configured to, and several stop after a pull has marked their
 * records read. The observable result is a device that keeps polling (so it looks alive) while
 * punches pile up in its own memory and never reach the ERP — with no error anywhere, because
 * nothing failed. Someone has to press "Sync device" for the data to appear.
 *
 * This removes that manual step: the server pulls every `DEVICE_SYNC_INTERVAL_MINUTES` and folds
 * whatever it finds. Push still works and still wins on latency when it is running; the two paths
 * converge on the same `(userId, deviceTimestamp)` dedupe, so a punch that arrives BOTH ways is
 * stored once.
 *
 * REQUIRES `DEVICE_IP` — the server must be able to reach the device on the LAN. On a host that
 * cannot (a cloud VPS behind NAT from the site), leave `DEVICE_IP` empty and this stays dormant;
 * push is then the only path and the device firmware must be configured for it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  ATTENDANCE_DEVICE_REPOSITORY,
  type AttendanceDeviceRepository,
} from '../domain/ports/attendance-device.repository';
import { DeviceSyncService } from './device-sync.service';

@Injectable()
export class DeviceAutoSyncService {
  private readonly logger = new Logger(DeviceAutoSyncService.name);

  /** 0 disables the job entirely — the escape hatch for a push-only deployment. */
  private readonly intervalMinutes: number;
  /** Guards the coarse cron tick against a slow pull; see `tick()`. */
  private lastRunAt = 0;

  constructor(
    private readonly sync: DeviceSyncService,
    @Inject(ATTENDANCE_DEVICE_REPOSITORY)
    private readonly devices: AttendanceDeviceRepository,
    @Inject(ConfigService) config: ConfigService,
  ) {
    const raw = Number(config.get<string>('DEVICE_SYNC_INTERVAL_MINUTES') ?? '3');
    this.intervalMinutes = Number.isFinite(raw) && raw >= 0 ? raw : 3;
  }

  /**
   * Fires every minute, but only ACTS once `intervalMinutes` have elapsed.
   *
   * A fixed `@Cron` cannot read a runtime-configured interval, so the schedule is deliberately
   * finer than the target period and the real gate is the elapsed-time check below. This also
   * means a pull that overruns its window simply delays the next one instead of stacking.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.intervalMinutes === 0) return;
    if (!this.sync.isConfigured()) return; // no DEVICE_IP — push-only deployment
    if (this.sync.isSyncing()) return; // a manual sync holds the device socket

    const elapsedMs = Date.now() - this.lastRunAt;
    if (elapsedMs < this.intervalMinutes * 60_000) return;
    this.lastRunAt = Date.now();

    await this.run();
  }

  private async run(): Promise<void> {
    let devices: Array<{ companyId: string; deviceSn: string; defaultProjectId: string | null }>;
    try {
      devices = await this.devices.listActiveForSync();
    } catch (error) {
      this.logger.error(`Auto-sync could not list devices: ${this.describe(error)}`);
      return;
    }

    if (devices.length === 0) {
      // Not an error: the puller dials DEVICE_IP, but the COMPANY to attribute punches to comes
      // from a registered device row. With none, a pull would have nowhere to file the result.
      this.logger.warn(
        'Auto-sync skipped — no active device registered. Register the device in ' +
          'Company settings → Attendance devices so pulled punches have a company.',
      );
      return;
    }

    // One socket at a time, and only ONE pull per company: the puller targets a single DEVICE_IP,
    // so two devices in the same company would otherwise pull the identical payload twice.
    const seen = new Set<string>();
    for (const device of devices) {
      if (seen.has(device.companyId)) continue;
      seen.add(device.companyId);

      try {
        const summary = await this.sync.sync(device.companyId, device.defaultProjectId);
        // Quiet on a no-op tick — this runs every few minutes and would otherwise flood the log.
        if (summary.attendance.inserted > 0 || summary.reconciled > 0) {
          this.logger.log(
            `Auto-sync: +${summary.attendance.inserted} punch(es), ` +
              `${summary.reconciled} day(s) reconciled (${summary.durationMs}ms)`,
          );
        }
      } catch (error) {
        // A device that is off, asleep, or mid-reboot is the normal case, not an incident —
        // warn rather than error so a nightly power-down does not read as a failure.
        this.logger.warn(`Auto-sync failed for company ${device.companyId}: ${this.describe(error)}`);
      }
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
