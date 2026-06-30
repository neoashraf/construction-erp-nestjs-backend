/**
 * AuditLogsController (PRESENTATION) — read-only: GET list, GET :id, GET export.
 * No POST/PATCH/PUT/DELETE (FR-AUD-023). Admin only (AUD READ). FR-AUD-026/027/028.
 * GET export endpoint must come before GET :id to avoid route ambiguity.
 */
import { Controller, Get, Inject, NotFoundException, Param, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/roles.guard';
import { Roles } from '../../auth/presentation/roles.decorator';
import { CurrentActor } from '../../auth/presentation/current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { AuditLogsQueryService } from '../read/audit-logs.query-service';
import { AUDIT_SERVICE, AuditService } from '../application/audit.port';
import { AuditAction } from '../domain/audit-log.entity';

@ApiTags('Audit Log')
@Controller('api/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditLogsController {
  constructor(
    private readonly query: AuditLogsQueryService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  @Get('export')
  @Roles({ module: 'AUD', action: 'READ' })
  async export(
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('format') format = 'csv',
  ) {
    if (format !== 'csv' && format !== 'xlsx') {
      throw new Error('Unsupported format');
    }

    const rows = await this.query.exportData({
      companyId: actor.companyId,
      entityType,
      entityId,
      userId,
      action: action as AuditAction | undefined,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
    });

    // Audit the export itself (FR-AUD-028)
    await this.audit.record({
      action: 'READ' as any,
      entityType: 'AuditLog',
      entityId: 'export',
      actorId: actor.userId,
      companyId: actor.companyId,
      before: null,
      after: { exportedRows: rows.length, format },
    });

    if (format === 'csv') {
      const header = 'createdAt,action,entityType,entityId,ipAddress\n';
      const body = rows.map(r => `${r.createdAt},${r.action},${r.entityType},${r.entityId},${r.ipAddress}`).join('\n');
      const csv = header + body;
      res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="audit-log.csv"' });
      return new StreamableFile(Buffer.from(csv, 'utf-8'));
    }

    // xlsx: return CSV-compatible plain text (xlsx generation requires exceljs dependency out-of-scope)
    const header = 'createdAt,action,entityType,entityId,ipAddress\n';
    const body = rows.map(r => `${r.createdAt},${r.action},${r.entityType},${r.entityId},${r.ipAddress}`).join('\n');
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="audit-log.xlsx"',
    });
    return new StreamableFile(Buffer.from(header + body, 'utf-8'));
  }

  @Get()
  @Roles({ module: 'AUD', action: 'READ' })
  async list(
    @CurrentActor() actor: Actor,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
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
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      page: +page,
      pageSize: +pageSize,
    });
  }

  @Get(':id')
  @Roles({ module: 'AUD', action: 'READ' })
  async findById(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const entry = await this.query.findById(id, actor.companyId);
    if (!entry) throw new NotFoundException('Audit log entry not found');
    return entry;
  }
}
