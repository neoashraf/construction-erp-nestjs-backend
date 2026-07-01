/** AuditLog read service (AUD read/ — FR-AUD-026/027/028). */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { AuditLogRepository, AuditQuery, AUDIT_LOG_REPOSITORY } from '../domain/ports/audit-log.repository.port';

/** Sanitised row returned by the export (FR-AUD-028 — no before/after/secrets). */
export interface AuditExportRow {
  createdAt: string;
  userName: string;
  action: string;
  entityType: string;
  entityId: string;
  projectId: string;
  ipAddress: string;
}

@Injectable()
export class AuditLogsQueryService {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY) private readonly repo: AuditLogRepository,
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  async list(filter: AuditQuery) {
    const { items, total } = await this.repo.query(filter);
    const rows = items.map(log => ({
      id: log.id,
      action: log.props.action,
      entityType: log.props.entityType,
      entityId: log.props.entityId,
      userId: log.props.userId,
      ipAddress: log.props.ipAddress,
      createdAt: log.props.createdAt,
    }));
    return { items: rows, total };
  }

  async findById(id: string, companyId: string) {
    const log = await this.repo.findById(id, companyId);
    if (!log) return null;
    return {
      id: log.id,
      action: log.props.action,
      entityType: log.props.entityType,
      entityId: log.props.entityId,
      userId: log.props.userId,
      before: log.props.before,
      after: log.props.after,
      ipAddress: log.props.ipAddress,
      seal: log.props.seal,
      createdAt: log.props.createdAt,
    };
  }

  /**
   * Unpaginated export query — JOINs with user table to get userName.
   * Returns sanitised rows (no before/after, no password_hash, no encrypted-at-rest fields).
   * projectId: audit_log has no project_id column; filter is a no-op, column returns empty (FR-AUD-028).
   * Runs via DataSource (read side, no aggregate) — reads outside UoW are fine (MVCC).
   */
  async exportData(filter: Omit<AuditQuery, 'page' | 'pageSize'>): Promise<AuditExportRow[]> {
    // Raw SQL avoids TypeORM query-builder quoting issues with the reserved "user" table name.
    const params: unknown[] = [filter.companyId];
    const conditions: string[] = ['al.company_id = $1'];

    if (filter.entityType) { params.push(filter.entityType); conditions.push(`al.entity_type = $${params.length}`); }
    if (filter.entityId)   { params.push(filter.entityId);   conditions.push(`al.entity_id = $${params.length}`); }
    if (filter.userId)     { params.push(filter.userId);     conditions.push(`al.user_id = $${params.length}`); }
    if (filter.action)     { params.push(filter.action);     conditions.push(`al.action = $${params.length}`); }
    if (filter.dateFrom)   { params.push(filter.dateFrom);   conditions.push(`al.created_at >= $${params.length}`); }
    if (filter.dateTo)     { params.push(filter.dateTo);     conditions.push(`al.created_at <= $${params.length}`); }
    // projectId: no project_id column on audit_log — filter not applied

    const where = conditions.join(' AND ');
    const sql = `
      SELECT
        al.created_at                    AS "createdAt",
        COALESCE(u.name, '')             AS "userName",
        al.action                        AS "action",
        al.entity_type                   AS "entityType",
        al.entity_id                     AS "entityId",
        ''                               AS "projectId",
        COALESCE(al.ip_address, '')      AS "ipAddress"
      FROM audit_log al
      LEFT JOIN "user" u ON al.user_id = u.id
      WHERE ${where}
      ORDER BY al.created_at DESC
    `;

    const rows = await this.dataSource.query<Array<{
      createdAt: Date | string;
      userName: string;
      action: string;
      entityType: string;
      entityId: string;
      projectId: string;
      ipAddress: string;
    }>>(sql, params);

    return rows.map(r => ({
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      userName: r.userName ?? '',
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      projectId: r.projectId ?? '',
      ipAddress: r.ipAddress ?? '',
    }));
  }
}
