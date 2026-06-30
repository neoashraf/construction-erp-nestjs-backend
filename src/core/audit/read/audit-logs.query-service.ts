/** AuditLog read service (AUD read/ — FR-AUD-026/027). */
import { Inject, Injectable } from '@nestjs/common';
import { AuditLogRepository, AuditQuery, AUDIT_LOG_REPOSITORY } from '../domain/ports/audit-log.repository.port';

@Injectable()
export class AuditLogsQueryService {
  constructor(@Inject(AUDIT_LOG_REPOSITORY) private readonly repo: AuditLogRepository) {}

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

  async exportData(filter: Omit<AuditQuery, 'page' | 'pageSize'>) {
    const logs = await this.repo.queryForExport(filter);
    return logs.map(log => ({
      createdAt: log.props.createdAt.toISOString(),
      action: log.props.action,
      entityType: log.props.entityType,
      entityId: log.props.entityId,
      ipAddress: log.props.ipAddress ?? '',
    }));
  }
}
