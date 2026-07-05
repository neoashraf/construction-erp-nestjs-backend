/**
 * NotificationsQueryService (NTF read/ — FR-NTF-003/013/014/015). Self-scoped reads for the bell feed:
 * the caller's own notifications (list + filters + pagination), the unread count, and a single row.
 * Company-scoped from the token; a foreign/unknown id resolves to null (→ 404, no enumeration).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { Actor } from '../../tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { NotificationView } from './dto/notification-view.dto';

export interface ListFilters {
  isRead?: boolean;
  type?: string;
  since?: string; // ISO-8601 UTC
  page?: number;
  pageSize?: number;
}

@Injectable()
export class NotificationsQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async list(actor: Actor, f: ListFilters): Promise<Paginated<NotificationView>> {
    const where: string[] = [`company_id = $1`, `recipient_user_id = $2`];
    const params: unknown[] = [actor.companyId, actor.userId];
    if (f.isRead !== undefined) { params.push(f.isRead); where.push(`is_read = $${params.length}`); }
    if (f.type) { params.push(f.type); where.push(`type = $${params.length}`); }
    if (f.since) { params.push(f.since); where.push(`created_at > $${params.length}`); }
    const whereSql = where.join(' AND ');

    const [countRow] = await this.ds.query(`SELECT count(*)::int AS c FROM notification WHERE ${whereSql}`, params);
    const total = countRow?.c ?? 0;

    const { page, pageSize, skip, take } = resolvePaging(f);
    const rows = await this.ds.query(
      `SELECT * FROM notification WHERE ${whereSql} ORDER BY created_at DESC LIMIT ${take} OFFSET ${skip}`,
      params,
    );
    return new Paginated(rows.map(toView), page, pageSize, total);
  }

  async unreadCount(actor: Actor): Promise<number> {
    const [row] = await this.ds.query(
      `SELECT count(*)::int AS c FROM notification WHERE company_id = $1 AND recipient_user_id = $2 AND is_read = false`,
      [actor.companyId, actor.userId],
    );
    return row?.c ?? 0;
  }

  async getForRecipient(actor: Actor, id: string): Promise<NotificationView | null> {
    const [row] = await this.ds.query(
      `SELECT * FROM notification WHERE id = $1 AND company_id = $2 AND recipient_user_id = $3`,
      [id, actor.companyId, actor.userId],
    );
    return row ? toView(row) : null;
  }
}

function toView(r: any): NotificationView {
  return {
    id: r.id,
    type: r.type,
    severity: r.severity,
    title: r.title,
    body: r.body,
    sourceModule: r.source_module,
    sourceEntityType: r.source_entity_type ?? null,
    sourceEntityId: r.source_entity_id ?? null,
    deepLink: r.deep_link ?? null,
    payload: r.payload ?? {},
    isRead: r.is_read,
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
