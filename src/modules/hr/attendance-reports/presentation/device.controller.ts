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
import type { Request } from 'express';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../../core/auth/presentation/require-permission.decorator';
import { NoEnvelope } from '../../../../infrastructure/http/no-envelope.decorator';
import { DeviceIngestionService } from '../application/device-ingestion.service';
import {
  DeviceStatusDto,
  DeviceStatusService,
} from '../application/device-status.service';
import { AttendanceReportExceptionFilter } from './attendance-report-exception.filter';
import { DevicePlainTextExceptionFilter } from './device-plaintext-exception.filter';
import { NoStoreInterceptor } from './no-store.interceptor';

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

  /** Handshake / heartbeat. The device hits this on boot and between uploads. */
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
  ) {}

  @Get('device/status')
  @RequirePermission('hr.attendance', 'READ')
  deviceStatus(): DeviceStatusDto {
    return this.status.getStatus();
  }

  /**
   * Sync view. This architecture is PUSH — the device sends to `/iclock/cdata`, the backend never dials
   * out to it — so "sync status" is really device liveness plus the newest punch ingested.
   */
  @Get('sync/status')
  @RequirePermission('hr.attendance', 'READ')
  async syncStatus(@CurrentActor() actor: Actor): Promise<{
    mode: 'push';
    device: DeviceStatusDto;
    lastRecordAt: Date | null;
    lastDeviceTimestamp: string | null;
  }> {
    const latest = await this.ingestion.findLatestPunch(actor.companyId);
    return {
      mode: 'push',
      device: this.status.getStatus(),
      lastRecordAt: latest?.receivedAt ?? null,
      lastDeviceTimestamp: latest?.deviceTimestamp ?? null,
    };
  }

  /**
   * 501 by design, not an omission: there is nothing to trigger. Punches arrive in real time because the
   * device pushes them. Answering 200 here would promise a pull that never happens.
   */
  @Post('sync')
  @HttpCode(501)
  @RequirePermission('hr.attendance', 'READ')
  sync(): { error: string } {
    return { error: 'Manual sync is not supported; the device pushes to /iclock/cdata' };
  }
}
