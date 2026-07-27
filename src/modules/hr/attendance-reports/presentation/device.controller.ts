/**
 * Device endpoints (SUPPORTING_APIS_GUIDE §4, §5). Two very different surfaces in one file because they
 * are two halves of one feature:
 *
 *   `/iclock/cdata`        — the DEVICE-FACING ingestion path. UNAUTHENTICATED by necessity.
 *   `/api/device/status`   — operator-facing liveness, behind the normal guards.
 *   `/api/sync*`           — operator-facing sync view, behind the normal guards.
 *
 * ── Why `/iclock/cdata` has no guard ────────────────────────────────────────────────────────────────
 * A ZKTeco device cannot present a JWT; it POSTs raw text and expects `OK`. So this route is deliberately
 * public, and the tenant is derived from the `?SN=` serial via `attendance_device`. An unregistered
 * serial has its punches DROPPED, which is what keeps the endpoint from being a write-anything hole:
 * an attacker must know a registered serial, and even then can only add punches for that one company.
 *
 * ⚠️ THIS IS STILL AN UNAUTHENTICATED WRITE PATH. Before exposing it to the internet, terminate it on the
 * site LAN/VPN or put an IP allowlist in front of it. Do not widen it beyond `/iclock`.
 *
 * ── Two device quirks the responses must respect ────────────────────────────────────────────────────
 *   1. The body MUST be plain text `OK`. ZKTeco firmware treats anything else (including `"OK"` with
 *      JSON quotes) as a failed upload and retries the batch forever. Hence `@Header` + `@NoEnvelope`.
 *   2. An EMPTY body still gets `200 OK` — devices send empty POSTs as heartbeats.
 * Ingestion errors are swallowed and logged for the same reason: replying non-OK would make the device
 * retry a batch that will fail identically, and the punches are already durable in `checkin_log`.
 *
 * Raw text arrives via the `/iclock` body parser registered in `main.ts`.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../../core/auth/presentation/require-permission.decorator';
import { NoEnvelope } from '../../../../infrastructure/http/no-envelope.decorator';
import {
  AttendanceImportService,
  type ImportResult,
} from '../application/attendance-import.service';
import { DeviceIngestionService } from '../application/device-ingestion.service';
import { DeviceSyncService, type SyncSummary } from '../application/device-sync.service';
import {
  DeviceStatusDto,
  DeviceStatusService,
} from '../application/device-status.service';
import { assertDateText, badRequest, formatLocalDate } from '../domain/attendance-rules';
import { AttendanceReportExceptionFilter } from './attendance-report-exception.filter';
import { DevicePlainTextExceptionFilter } from './device-plaintext-exception.filter';
import { NoStoreInterceptor } from './no-store.interceptor';

/** Optional window for a manual re-reconcile; validated by `assertDateText` for the contract messages. */
class SyncRequestDto {
  @IsOptional() @IsString() dateFrom?: string;
  @IsOptional() @IsString() dateTo?: string;
}

/**
 * One spreadsheet row. Every field is an optional STRING on purpose: the shapes and messages
 * are decided by the pure parser (`attendance-import.parser`), which reports the offending
 * SHEET ROW NUMBER. Letting class-validator reject the payload instead would produce
 * "rows.417.date must match /…/" — accurate but useless to someone looking at Excel.
 */
class ImportRowDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() checkIn?: string;
  @IsOptional() @IsString() checkOut?: string;
}

class ImportRequestDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportRowDto)
  rows!: ImportRowDto[];
}

function remoteAddressOf(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function rawBodyOf(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body === undefined || body === null) return '';
  return String(body);
}

/** Device-facing ingestion. No guards — see the file header. Always answers plain-text `OK`. */
@ApiTags('HR / Device Ingestion')
@Controller('iclock')
@UseFilters(DevicePlainTextExceptionFilter)
@NoEnvelope()
export class DeviceIngestionController {
  private readonly logger = new Logger(DeviceIngestionController.name);

  constructor(
    private readonly ingestion: DeviceIngestionService,
    private readonly status: DeviceStatusService,
  ) {}

  /** Handshake. The device hits this on boot to register itself. */
  @Get('cdata')
  @Header('Content-Type', 'text/plain')
  handshake(@Req() req: Request, @Query('SN') sn?: string): string {
    this.status.markSeen({
      method: req.method,
      path: req.originalUrl,
      remoteAddress: remoteAddressOf(req),
      deviceSn: sn ?? null,
    });
    this.logger.log(`Fingerprint device CONNECTED (sn=${sn ?? 'unknown'}, ip=${remoteAddressOf(req)})`);
    return 'OK';
  }

  /**
   * POLL / KEEP-ALIVE — the device's real heartbeat.
   *
   * Between uploads a ZKTeco unit polls `/iclock/getrequest` every 30–60s asking "any command
   * for me?", and some firmwares also send `/iclock/ping`. Both are how the device says "I am
   * alive"; `cdata` only fires on boot and when there are punches to deliver.
   *
   * These routes existed nowhere before, so the device got a 404 for every poll and liveness
   * was never stamped. The badge therefore tracked PUNCH ACTIVITY rather than the device: it
   * went Live when somebody scanned a finger and fell back to Offline two minutes later, even
   * though the unit was plugged in and polling the whole time.
   *
   * The reply must be plain text. `getrequest` answers EMPTY — that is the protocol's "no
   * commands queued", and this system never pushes commands down to the device; `ping`
   * answers `OK`. Returning the wrong one makes some firmwares log an error and back off.
   */
  @Get(['getrequest', 'ping'])
  @Header('Content-Type', 'text/plain')
  poll(@Req() req: Request, @Query('SN') sn?: string): string {
    this.status.markSeen({
      method: req.method,
      path: req.originalUrl,
      remoteAddress: remoteAddressOf(req),
      deviceSn: sn ?? null,
    });
    // Deliberately NOT logged at `log` level: this fires every 30–60s per device and would
    // bury everything else. The heartbeat is observable via `GET /api/device/status`.
    this.logger.debug(`Device poll (sn=${sn ?? 'unknown'}, ip=${remoteAddressOf(req)})`);
    return req.path.endsWith('/ping') ? 'OK' : '';
  }

  /** Punch upload. Always answers `OK`; see the file header for why failures are swallowed. */
  @Post('cdata')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  async upload(
    @Req() req: Request,
    @Body() body: unknown,
    @Query('SN') sn?: string,
  ): Promise<string> {
    this.status.markSeen({
      method: req.method,
      path: req.originalUrl,
      remoteAddress: remoteAddressOf(req),
      deviceSn: sn ?? null,
    });

    const rawBody = rawBodyOf(body);
    if (!rawBody.trim()) return 'OK'; // empty POST = heartbeat

    try {
      const result = await this.ingestion.ingest(rawBody, sn ?? null);
      this.logger.log(
        `Device ${sn ?? 'unknown'}: parsed=${result.parsed} stored=${result.stored} ` +
          `reconciled=${result.reconciled} ignored=${result.ignoredLines}`,
      );
    } catch (error) {
      // Never surface a failure to the device: it would retry the identical batch indefinitely.
      this.logger.error(
        `Device ${sn ?? 'unknown'}: ingestion failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    return 'OK';
  }
}

/** Operator-facing device liveness and sync view. Normal guards + the flat error contract apply. */
@ApiTags('HR / Device Ingestion')
@Controller('api')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(AttendanceReportExceptionFilter)
@UseInterceptors(NoStoreInterceptor)
@NoEnvelope()
export class DeviceStatusController {
  constructor(
    private readonly status: DeviceStatusService,
    private readonly ingestion: DeviceIngestionService,
    private readonly syncService: DeviceSyncService,
    private readonly importService: AttendanceImportService,
  ) {}

  @Get('device/status')
  @RequirePermission('hr.attendance', 'READ')
  deviceStatus(): DeviceStatusDto {
    return this.status.getStatus();
  }

  /**
   * Sync view. Reports BOTH ingestion paths: `configured`/`deviceIp`/`lastSync*` describe the PULL
   * path (`POST /api/sync`), while `device`/`lastRecordAt` describe what has actually arrived —
   * whether it came by push or by pull.
   */
  @Get('sync/status')
  @RequirePermission('hr.attendance', 'READ')
  async syncStatus(@CurrentActor() actor: Actor): Promise<{
    syncing: boolean;
    configured: boolean;
    deviceIp: string | null;
    devicePort: number | null;
    lastSyncAt: Date | null;
    lastSync: SyncSummary | null;
    device: DeviceStatusDto;
    lastRecordAt: Date | null;
    lastDeviceTimestamp: string | null;
  }> {
    const latest = await this.ingestion.findLatestPunch(actor.companyId);
    const { at, summary } = this.syncService.lastSync();
    const target = this.syncService.target();
    const configured = this.syncService.isConfigured();

    return {
      syncing: this.syncService.isSyncing(),
      configured,
      deviceIp: configured ? target.ip : null,
      devicePort: configured ? target.port : null,
      lastSyncAt: at,
      lastSync: summary,
      device: this.status.getStatus(),
      lastRecordAt: latest?.receivedAt ?? null,
      lastDeviceTimestamp: latest?.deviceTimestamp ?? null,
    };
  }

  /**
   * Manual sync — PULL from the device, then reconcile.
   *
   * Opens a socket to `DEVICE_IP`, pulls the roster and punch history in one connection, stores the
   * punches (idempotent on `(userId, deviceTimestamp)`, so pressing twice never duplicates history)
   * and folds the touched employee-days into `attendance_record`.
   *
   * Status codes carry real meaning here:
   *   409 — a sync is already running (a second socket makes the firmware drop both)
   *   503 — no `DEVICE_IP` configured, so there is nothing to dial
   *   502 — the device did not answer
   *
   * ── When no device is configured ────────────────────────────────────────────────────────────────
   * Falls back to RE-RECONCILE over punches already in `checkin_log` for the given window (default:
   * last 30 days). That is still a useful operation — ingestion skips any employee-day it cannot place
   * (unknown employee code, no project, no financial year) and nothing retries those automatically, so
   * after an admin fixes the underlying data this is what brings them into the reports. A push-only
   * deployment (e.g. a cloud host that cannot reach the device LAN) therefore keeps a working button.
   */
  @Post('sync')
  @HttpCode(200)
  @RequirePermission('hr.attendance', 'UPDATE')
  async sync(
    @Body() body: SyncRequestDto,
    @CurrentActor() actor: Actor,
  ): Promise<Record<string, unknown>> {
    // An EXPLICIT window means "re-reconcile these days", never "pull the device": after an
    // admin fixes an employee, project or financial year, this is the only way to bring the
    // affected punches into the reports. A pull would just re-fetch the same punches and
    // reconcile only the days it happened to see.
    const windowRequested = Boolean(body.dateFrom || body.dateTo);

    // No device address → same fallback, so a push-only deployment keeps a working button.
    if (windowRequested || !this.syncService.isConfigured()) {
      const today = new Date();
      const dateTo = body.dateTo ? assertDateText(body.dateTo, 'dateTo') : formatLocalDate(today);
      const dateFrom = body.dateFrom
        ? assertDateText(body.dateFrom, 'dateFrom')
        : formatLocalDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29));

      if (dateFrom > dateTo) throw badRequest('dateFrom must not be after dateTo');

      // Pass the device's default project: an employee with no project of their own would
      // otherwise be skipped as NO_PROJECT even though the device supplies a fallback.
      const defaultProjectId = await this.ingestion.findDefaultProject(actor.companyId);
      const result = await this.ingestion.resync(
        actor.companyId,
        dateFrom,
        dateTo,
        defaultProjectId,
      );
      return { mode: 'reconcile', dateFrom, dateTo, ...result };
    }

    const mapping = await this.ingestion.findDefaultProject(actor.companyId);
    const summary = await this.syncService.sync(actor.companyId, mapping);
    return { mode: 'pull', ...summary };
  }

  /**
   * Import attendance from a spreadsheet — the third ingestion path.
   *
   * The BROWSER parses the workbook (SheetJS) and posts plain JSON rows; the server never sees
   * a binary file. That keeps a large, CPU-heavy, CVE-prone parser out of the API process, and
   * means a malformed workbook fails in the tab that opened it rather than on the server.
   *
   * Rows land in `checkin_log` through the SAME `insertPunches`/`reconcileDays` pair the device
   * uses, so imported and device-recorded days are indistinguishable afterwards — and because
   * that pair dedupes on `(company, user, deviceTimestamp)`, re-importing a file, or importing
   * days the device later reports, adds nothing rather than doubling history.
   *
   * Answers 200 with per-row errors rather than 4xx-ing the batch: one typo in row 417 must not
   * discard the other 499 good rows. A 400 is reserved for a payload that is unusable as a
   * whole (empty, or past the size guards).
   *
   * Requires `hr.attendance:UPDATE` — this writes attendance, exactly like a sync.
   */
  @Post('attendance/import')
  @HttpCode(200)
  @RequirePermission('hr.attendance', 'UPDATE')
  async importAttendance(
    @Body() body: ImportRequestDto,
    @CurrentActor() actor: Actor,
  ): Promise<ImportResult> {
    // Same fallback the pull path uses: an employee with no project of their own would
    // otherwise be skipped as NO_PROJECT even though the device row supplies a default.
    const defaultProjectId = await this.ingestion.findDefaultProject(actor.companyId);
    return this.importService.import(actor.companyId, defaultProjectId, body.rows ?? []);
  }
}
