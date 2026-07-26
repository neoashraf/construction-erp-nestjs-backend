/**
 * AttendanceLogController — `GET /api/logs` and `/api/logs/export` (SUPPORTING_APIS_GUIDE §2).
 *
 * ROUTE ORDER: `export` is declared BEFORE the bare `/` route, per the guide's warning.
 *
 * ⚠️ THIS IS THE DEVICE-LOG VIEW, not attendance truth. It reads raw punches from `checkin_log`, because
 * every field in its contract (`deviceTimestamp`, `occurredAt`, `receivedAt`, `punchCount`, per-punch
 * `id`) is punch-level. Attendance captured WITHOUT a device — manual entry or CSV biometric import —
 * has no punch rows and so does not appear here.
 *
 * ⚠️ `attendanceRecords` is NOT gap-free: punch-less non-holiday days are omitted and counted only in
 * `absentCount`. For a calendar or for attendance truth use `/api/reports/range`, which reads
 * `attendance_record` and fills every date.
 *
 * Same envelope/error opt-outs as the other routes in this module so the bodies match the contract.
 */
import {
  Controller,
  Get,
  Query,
  Res,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { Response } from 'express';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../../core/auth/presentation/require-permission.decorator';
import { NoEnvelope } from '../../../../infrastructure/http/no-envelope.decorator';
import {
  AttendanceLogResult,
  AttendanceLogService,
} from '../application/attendance-log.service';
import { AttendanceReportExceptionFilter } from './attendance-report-exception.filter';
import { NoStoreInterceptor } from './no-store.interceptor';

/** Excel only detects UTF-8 in a CSV when the file opens with a byte order mark. */
const UTF8_BOM = '﻿';

class AttendanceLogQueryDto {
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() dateFrom?: string;
  @IsOptional() @IsString() dateTo?: string;
}

@ApiTags('HR / Attendance Logs')
@Controller('api/logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(AttendanceReportExceptionFilter)
@UseInterceptors(NoStoreInterceptor)
@NoEnvelope()
export class AttendanceLogController {
  constructor(private readonly logs: AttendanceLogService) {}

  /** Declared BEFORE `@Get()` so the bare route never shadows it. */
  @Get('export')
  @RequirePermission('hr.attendance', 'READ')
  async export(
    @Query() q: AttendanceLogQueryDto,
    @CurrentActor() actor: Actor,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.logs.exportCsv(q, actor);
    const suffix = q.date || [q.dateFrom, q.dateTo].filter(Boolean).join('_to_') || 'today';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${suffix}.csv"`);
    res.send(`${UTF8_BOM}${csv}`);
  }

  @Get()
  @RequirePermission('hr.attendance', 'READ')
  list(
    @Query() q: AttendanceLogQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<AttendanceLogResult> {
    return this.logs.getLogs(q, actor);
  }
}
