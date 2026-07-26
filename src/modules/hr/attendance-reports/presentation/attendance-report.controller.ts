/**
 * AttendanceReportController — the six read-only attendance-report routes (REPORTS_MODULE_GUIDE §1/§4):
 *
 *   GET /api/reports/daily            GET /api/reports/daily/export
 *   GET /api/reports/range            GET /api/reports/range/export
 *   GET /api/reports/summary          GET /api/reports/summary/export
 *
 * A thin transport layer — every rule lives in `AttendanceReportService`. Two deliberate departures from
 * the platform defaults, both so the JSON matches the source contract byte-for-byte:
 *   - `@NoEnvelope()` keeps the `{ data, meta }` success wrapper off these bodies;
 *   - `@UseFilters(AttendanceReportExceptionFilter)` renders the flat `{ "error": "…" }` error body.
 * Everything else is standard: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@RequirePermission` on every
 * route (CLAUDE.md — never ship a controller without guards), company implicit from the JWT actor.
 *
 * The export routes write the response directly (`@Res()`), because a CSV download needs its own
 * `Content-Type` / `Content-Disposition` and must be prefixed with a UTF-8 BOM — without the BOM Excel
 * mis-decodes Bangla and other non-ASCII names (§5.1). They ignore `page`/`limit` by design: an export
 * is always the whole filtered set (§3.6).
 *
 * NOTE ON PATH: this shares the `/api/reports` prefix with RPT's `ReportsController` but lives in HR,
 * which owns `employee` + `attendance_record`. Nest resolves route prefixes independently of module, and
 * none of the six paths collide with RPT's report names.
 */
import { Controller, Get, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../../core/auth/presentation/require-permission.decorator';
import { NoEnvelope } from '../../../../infrastructure/http/no-envelope.decorator';
import { AttendanceReportService } from '../application/attendance-report.service';
import { DailyReport, RangeReport, SummaryReport } from '../domain/attendance-report.model';
import { formatLocalDate } from '../domain/attendance-rules';
import { AttendanceReportExceptionFilter } from './attendance-report-exception.filter';
import { DailyReportQueryDto, RangeReportQueryDto } from './dto/attendance-report-query.dto';

/** Excel only detects UTF-8 in a CSV when the file opens with a byte order mark. */
const UTF8_BOM = '﻿';

@ApiTags('HR / Attendance Reports')
@Controller('api/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(AttendanceReportExceptionFilter)
@NoEnvelope()
export class AttendanceReportController {
  constructor(private readonly reports: AttendanceReportService) {}

  /** Report 1 — one row per employee for a single day. Query: date, page, limit, userId, name. */
  @Get('daily')
  @RequirePermission('hr.attendance', 'READ')
  daily(@Query() q: DailyReportQueryDto, @CurrentActor() actor: Actor): Promise<DailyReport> {
    return this.reports.getDailyReport(q, actor);
  }

  @Get('daily/export')
  @RequirePermission('hr.attendance', 'READ')
  async dailyExport(
    @Query() q: DailyReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.reports.exportDailyReportCsv(q, actor);
    this.sendCsv(res, `attendance-daily-${q.date || formatLocalDate()}.csv`, csv);
  }

  /** Report 2 — day-by-day breakdown per employee. Query: dateFrom, dateTo, page, limit, userId, name. */
  @Get('range')
  @RequirePermission('hr.attendance', 'READ')
  range(@Query() q: RangeReportQueryDto, @CurrentActor() actor: Actor): Promise<RangeReport> {
    return this.reports.getRangeReport(q, actor);
  }

  @Get('range/export')
  @RequirePermission('hr.attendance', 'READ')
  async rangeExport(
    @Query() q: RangeReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.reports.exportRangeReportCsv(q, actor);
    this.sendCsv(res, `attendance-range-${this.rangeSuffix(q.dateFrom, q.dateTo)}.csv`, csv);
  }

  /** Report 3 — totals only, no per-day rows. Same query parameters as `range`. */
  @Get('summary')
  @RequirePermission('hr.attendance', 'READ')
  summary(@Query() q: RangeReportQueryDto, @CurrentActor() actor: Actor): Promise<SummaryReport> {
    return this.reports.getSummaryReport(q, actor);
  }

  @Get('summary/export')
  @RequirePermission('hr.attendance', 'READ')
  async summaryExport(
    @Query() q: RangeReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.reports.exportSummaryReportCsv(q, actor);
    this.sendCsv(res, `attendance-summary-${this.rangeSuffix(q.dateFrom, q.dateTo)}.csv`, csv);
  }

  private sendCsv(res: Response, filename: string, csv: string): void {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`${UTF8_BOM}${csv}`);
  }

  /** `<from>_to_<to>` when both ends were given, otherwise today — matches the source filenames. */
  private rangeSuffix(dateFrom?: string, dateTo?: string): string {
    if (dateFrom && dateTo) {
      return `${dateFrom}_to_${dateTo}`;
    }
    return formatLocalDate();
  }
}
