/**
 * AuditLogsController (PRESENTATION) — read-only: GET list, GET :id, GET export.
 * No POST/PATCH/PUT/DELETE (FR-AUD-023). Admin only (AUD READ). FR-AUD-026/027/028.
 * GET export endpoint must come before GET :id to avoid route ambiguity.
 */
import {
  Controller, Get, Inject, NotFoundException, Param, Query,
  Req, Res, StreamableFile, UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import * as ExcelJS from 'exceljs';
import { JwtAuthGuard } from '../../auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/roles.guard';
import { RequirePermission } from '../../auth/presentation/require-permission.decorator';
import { CurrentActor } from '../../auth/presentation/current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { AuditLogsQueryService } from '../read/audit-logs.query-service';
import { AUDIT_SERVICE, AuditService } from '../application/audit.port';
import { AuditAction } from '../domain/audit-log.entity';
import { UnitOfWork, UNIT_OF_WORK } from '../../../common/ports/unit-of-work.port';
import { ValidationError } from '../../../common/errors/domain-error';
import { NoEnvelope } from '../../../infrastructure/http/no-envelope.decorator';

/** Actions valid on the list/export filter (mirrors the domain AuditAction set minus EXPORT). */
const VALID_FILTER_ACTIONS = new Set<string>([
  'CREATE', 'UPDATE', 'DELETE', 'POST', 'CANCEL', 'APPROVE', 'REJECT', 'ACTIVATE', 'DEACTIVATE',
]);

function parseDate(raw: string, label: string): Date {
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    throw new ValidationError(`${label} is not a valid ISO-8601 date`, { [label]: raw });
  }
  return d;
}

function escapeCsvCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

@ApiTags('Audit Log')
@Controller('api/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditLogsController {
  constructor(
    private readonly query: AuditLogsQueryService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  /**
   * GET /api/audit-logs/export — filtered, sanitised file download (FR-AUD-028).
   * Must come BEFORE /:id to avoid route ambiguity.
   * Response body is the raw file (no {data,meta} envelope — overview §6 binary exception).
   */
  @Get('export')
  @RequirePermission('audit.audit_log', 'READ')
  @NoEnvelope()
  async export(
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('projectId') projectId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('format') format = 'csv',
  ): Promise<StreamableFile> {
    // --- validate params ---
    if (format !== 'csv' && format !== 'xlsx') {
      throw new ValidationError('format must be csv or xlsx', { format });
    }
    if (action && !VALID_FILTER_ACTIONS.has(action)) {
      throw new ValidationError(
        `action must be one of: ${[...VALID_FILTER_ACTIONS].join(', ')}`,
        { action },
      );
    }
    const parsedFrom = dateFrom ? parseDate(dateFrom, 'dateFrom') : undefined;
    const parsedTo   = dateTo   ? parseDate(dateTo, 'dateTo')     : undefined;

    const filter = {
      companyId: actor.companyId,
      entityType,
      entityId,
      userId,
      action: action as AuditAction | undefined,
      projectId,
      dateFrom: parsedFrom,
      dateTo: parsedTo,
    };

    // --- read export rows + audit the export inside one UoW (FR-AUD-028 / FR-AUD-025) ---
    const rows = await this.uow.run(async () => {
      const exportRows = await this.query.exportData(filter);
      // The export itself is audit-logged as a READ on the trail (append-only — FR-AUD-023).
      await this.audit.record({
        action: 'EXPORT',
        entityType: 'AuditLog',
        entityId: 'export',
        actorId: actor.userId,
        companyId: actor.companyId,
        before: null,
        after: { exportedRows: exportRows.length, format },
      });
      return exportRows;
    });

    // --- build filename: audit-log-DD-MM-YYYY.<ext> ---
    const now = new Date();
    const dd   = String(now.getDate()).padStart(2, '0');
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const filename = `audit-log-${dd}-${mm}-${yyyy}.${format}`;

    const requestId = req.id ?? (req.headers['x-request-id'] as string | undefined) ?? '';

    // --- build file ---
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet    = workbook.addWorksheet('Audit Log');
      sheet.columns  = [
        { header: 'Timestamp',   key: 'createdAt',   width: 30 },
        { header: 'User',        key: 'userName',     width: 25 },
        { header: 'Action',      key: 'action',       width: 15 },
        { header: 'Entity Type', key: 'entityType',   width: 20 },
        { header: 'Entity ID',   key: 'entityId',     width: 38 },
        { header: 'Project ID',  key: 'projectId',    width: 38 },
        { header: 'IP Address',  key: 'ipAddress',    width: 15 },
      ];
      sheet.addRows(rows);
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Request-Id': requestId,
      });
      return new StreamableFile(buffer);
    }

    // CSV — UTF-8 BOM so Excel opens Bangla text without mangling (SRS §9).
    const BOM     = '﻿';
    const header  = 'Timestamp,User,Action,Entity Type,Entity ID,Project ID,IP Address';
    const csvRows = rows
      .map(r =>
        [r.createdAt, r.userName, r.action, r.entityType, r.entityId, r.projectId, r.ipAddress]
          .map(cell => escapeCsvCell(String(cell ?? '')))
          .join(','),
      )
      .join('\n');

    const csv = BOM + header + '\n' + csvRows;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Request-Id': requestId,
    });
    return new StreamableFile(Buffer.from(csv, 'utf-8'));
  }

  @Get()
  @RequirePermission('audit.audit_log', 'READ')
  async list(
    @CurrentActor() actor: Actor,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('projectId') projectId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.query.list({
      companyId: actor.companyId,
      entityType,
      entityId,
      userId,
      action: action as AuditAction | undefined,
      projectId,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      page: +page,
      pageSize: +pageSize,
    });
  }

  @Get(':id')
  @RequirePermission('audit.audit_log', 'READ')
  async findById(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const entry = await this.query.findById(id, actor.companyId);
    if (!entry) throw new NotFoundException('Audit log entry not found');
    return entry;
  }
}
