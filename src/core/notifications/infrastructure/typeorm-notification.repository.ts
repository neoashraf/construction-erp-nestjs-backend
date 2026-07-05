/**
 * TypeOrmNotificationRepository (NTF INFRASTRUCTURE). Raw SQL over `notification`; company-scoped.
 * Uses the DataSource directly (NOT the ambient UoW manager) so notification writes are always
 * out-of-band — they never join, extend, or fail a producer's business transaction (FR-NTF-012).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { NotificationRepository } from '../domain/ports/notification.repository.port';
import { NotificationRecord } from '../domain/notification-record';

/**
 * TypeORM's `query()` returns a plain row array for SELECT / INSERT…RETURNING, but a
 * `[rows, affectedCount]` tuple for UPDATE / DELETE…RETURNING (pg driver). Normalise to the rows.
 */
function rowsOf(result: any): any[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0];
  }
  return result as any[];
}

@Injectable()
export class TypeOrmNotificationRepository implements NotificationRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insertIfAbsent(r: NotificationRecord): Promise<boolean> {
    const rows = await this.ds.query(
      `INSERT INTO notification
         (id, company_id, recipient_user_id, type, severity, title, body,
          source_module, source_entity_type, source_entity_id, deep_link, payload, event_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
       ON CONFLICT (recipient_user_id, event_key) DO NOTHING
       RETURNING id`,
      [
        r.id, r.companyId, r.recipientUserId, r.type, r.severity, r.title, r.body,
        r.sourceModule, r.sourceEntityType, r.sourceEntityId,
        r.deepLink ? JSON.stringify(r.deepLink) : null, JSON.stringify(r.payload ?? {}), r.eventKey,
      ],
    );
    return rows.length > 0;
  }

  async markOneRead(id: string, recipientUserId: string, companyId: string): Promise<Date | null> {
    const rows = rowsOf(await this.ds.query(
      `UPDATE notification SET is_read = true, read_at = COALESCE(read_at, now())
       WHERE id = $1 AND recipient_user_id = $2 AND company_id = $3
       RETURNING read_at`,
      [id, recipientUserId, companyId],
    ));
    return rows.length > 0 ? new Date(rows[0].read_at) : null;
  }

  async markAllRead(recipientUserId: string, companyId: string, type?: string): Promise<number> {
    const params: unknown[] = [recipientUserId, companyId];
    let typeSql = '';
    if (type) { params.push(type); typeSql = ` AND type = $${params.length}`; }
    const rows = rowsOf(await this.ds.query(
      `UPDATE notification SET is_read = true, read_at = now()
       WHERE recipient_user_id = $1 AND company_id = $2 AND is_read = false${typeSql}
       RETURNING id`,
      params,
    ));
    return rows.length;
  }

  async unreadCount(companyId: string, recipientUserId: string): Promise<number> {
    const [row] = await this.ds.query(
      `SELECT count(*)::int AS c FROM notification WHERE company_id = $1 AND recipient_user_id = $2 AND is_read = false`,
      [companyId, recipientUserId],
    );
    return row?.c ?? 0;
  }
}
