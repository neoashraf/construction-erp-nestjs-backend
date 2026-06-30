/**
 * TypeOrmAuditLogRepository (INFRASTRUCTURE) — append-only audit_log.
 * Uses the active UoW transaction so audit entries commit with the business write (FR-AUD-025).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { AuditLog } from '../domain/audit-log.entity';
import { AuditLogRepository, AuditQuery } from '../domain/ports/audit-log.repository.port';
import { AuditLogOrmEntity } from './audit-log.orm-entity';

@Injectable()
export class TypeOrmAuditLogRepository implements AuditLogRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(AuditLogOrmEntity);
  }

  async append(log: AuditLog): Promise<void> {
    const p = log.props;
    await this.repo().insert({
      id: log.id,
      companyId: p.companyId,
      action: p.action,
      entityType: p.entityType,
      entityId: p.entityId,
      userId: p.userId,
      before: p.before as any,
      after: p.after as any,
      ipAddress: p.ipAddress,
      seal: p.seal,
      createdAt: p.createdAt,
    });
  }

  async lastSeal(companyId: string): Promise<string | null> {
    const rows = await this.repo().find({
      where: { companyId },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    return rows[0]?.seal ?? null;
  }

  async findById(id: string, companyId: string): Promise<AuditLog | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  async query(filter: AuditQuery): Promise<{ items: AuditLog[]; total: number }> {
    const qb = this.repo().createQueryBuilder('al')
      .where('al.companyId = :companyId', { companyId: filter.companyId });

    if (filter.entityType) qb.andWhere('al.entityType = :entityType', { entityType: filter.entityType });
    if (filter.entityId) qb.andWhere('al.entityId = :entityId', { entityId: filter.entityId });
    if (filter.userId) qb.andWhere('al.userId = :userId', { userId: filter.userId });
    if (filter.action) qb.andWhere('al.action = :action', { action: filter.action });
    if (filter.dateFrom) qb.andWhere('al.createdAt >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('al.createdAt <= :dateTo', { dateTo: filter.dateTo });

    const [rows, total] = await qb
      .orderBy('al.createdAt', 'DESC')
      .skip((filter.page - 1) * filter.pageSize)
      .take(filter.pageSize)
      .getManyAndCount();

    return { items: rows.map(toDomain), total };
  }

  async queryForExport(filter: Omit<AuditQuery, 'page' | 'pageSize'>): Promise<AuditLog[]> {
    const qb = this.repo().createQueryBuilder('al')
      .where('al.companyId = :companyId', { companyId: filter.companyId });
    if (filter.entityType) qb.andWhere('al.entityType = :entityType', { entityType: filter.entityType });
    if (filter.entityId) qb.andWhere('al.entityId = :entityId', { entityId: filter.entityId });
    if (filter.userId) qb.andWhere('al.userId = :userId', { userId: filter.userId });
    if (filter.action) qb.andWhere('al.action = :action', { action: filter.action });
    if (filter.dateFrom) qb.andWhere('al.createdAt >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('al.createdAt <= :dateTo', { dateTo: filter.dateTo });
    const rows = await qb.orderBy('al.createdAt', 'DESC').getMany();
    return rows.map(toDomain);
  }

  async verifyChain(companyId: string, from?: Date, to?: Date): Promise<{ ok: boolean; brokenAt?: string }> {
    // created_at formatted to match JS Date.toISOString() (YYYY-MM-DDTHH:MM:SS.mmmZ)
    const createdAtExpr = `to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const qb = this.dataSource.createQueryBuilder()
      .select(['id', 'action', '"entity_type"', '"entity_id"', '"user_id"', 'before::text', 'after::text', `${createdAtExpr} AS "created_at"`, 'seal'])
      .from('audit_log', 'al')
      .where('"company_id" = :companyId', { companyId })
      .orderBy('"created_at"', 'ASC');
    if (from) qb.andWhere('"created_at" >= :from', { from });
    if (to) qb.andWhere('"created_at" <= :to', { to });

    const rows = await qb.getRawMany();
    let prevSeal: string | null = null;

    for (const row of rows) {
      // Parse jsonb text back to JS values so JSON.stringify inside computeSeal produces the same string as at write time
      const before = row.before != null ? JSON.parse(row.before) : null;
      const after = row.after != null ? JSON.parse(row.after) : null;
      const expected = computeSeal(companyId, row.action, row.entity_type, row.entity_id, row.user_id,
        before, after, row.created_at, prevSeal);
      if (expected !== row.seal) {
        return { ok: false, brokenAt: row.id };
      }
      prevSeal = row.seal;
    }
    return { ok: true };
  }
}

function toDomain(r: AuditLogOrmEntity): AuditLog {
  return AuditLog.rehydrate(r.id, {
    companyId: r.companyId,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    userId: r.userId,
    before: r.before,
    after: r.after,
    ipAddress: r.ipAddress,
    seal: r.seal,
    createdAt: r.createdAt,
  });
}

export function computeSeal(
  companyId: string,
  action: string,
  entityType: string,
  entityId: string,
  userId: string,
  before: unknown,
  after: unknown,
  createdAt: unknown,
  prevSeal: string | null,
): string {
  const parts = [
    prevSeal ?? '',
    companyId,
    action,
    entityType,
    entityId,
    userId,
    JSON.stringify(before ?? null),
    JSON.stringify(after ?? null),
    String(createdAt),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
