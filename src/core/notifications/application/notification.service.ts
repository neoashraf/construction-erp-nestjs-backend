/**
 * NotificationService (NTF application — FR-NTF-016..021, 002/010/011/012). The internal `emit(command)`
 * seam every producer calls AFTER its own commit (out-of-band): it validates the type, resolves recipients
 * from the catalogue rule (excluding inactive users), fans out one persisted row per recipient (idempotent
 * on (recipient, eventKey)), and pushes live over the NotificationPusher — best-effort, so a push failure
 * never propagates to the caller. NTF owns delivery only; it writes no ledger and computes no business rule.
 *
 * There is NO HTTP entry to this — a client cannot author a notification (SRS 18 §5.7).
 */
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IdGenerator, ID_GENERATOR } from '../../../common/ports/id-generator.port';
import { Actor } from '../../tenancy/tenant-context';
import { NotificationRepository, NOTIFICATION_REPOSITORY } from '../domain/ports/notification.repository.port';
import { RecipientResolver, RECIPIENT_RESOLVER } from '../domain/ports/recipient-resolver.port';
import { NotificationPusher, NOTIFICATION_PUSHER } from '../domain/ports/notification-pusher.port';
import { getNotificationType } from '../domain/notification-catalog';
import { EmitCommand, NotificationRecord, buildNotificationRecord } from '../domain/notification-record';
import { NotificationView } from '../read/dto/notification-view.dto';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository,
    @Inject(RECIPIENT_RESOLVER) private readonly resolver: RecipientResolver,
    @Inject(NOTIFICATION_PUSHER) private readonly pusher: NotificationPusher,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** Raise a notification: resolve recipients → fan-out (idempotent) → best-effort live push. Returns #created. */
  async emit(command: EmitCommand): Promise<{ created: number }> {
    const def = getNotificationType(command.type);
    if (!def) throw new Error(`UNKNOWN_NOTIFICATION_TYPE: ${command.type}`);

    // Resolve every rule and union the recipient set (the resolver already excludes inactive users).
    const recipientSet = new Set<string>();
    for (const rule of def.recipients) {
      const ids = await this.resolver.resolve(rule, {
        companyId: command.companyId,
        projectId: command.projectId,
        affectedUserId: command.affectedUserId,
      });
      ids.forEach(id => recipientSet.add(id));
    }

    let created = 0;
    for (const recipientUserId of recipientSet) {
      const record = buildNotificationRecord(this.ids.next(), recipientUserId, command, def);
      const inserted = await this.repo.insertIfAbsent(record); // idempotent on (recipient, eventKey)
      if (!inserted) continue; // duplicate event → no second row, no push (FR-NTF-019)
      created += 1;
      await this.pushBestEffort(record);
    }
    return { created };
  }

  /** Mark one own notification read (idempotent); 404 if it is not the caller's. Pushes the new count. */
  async markOneRead(actor: Actor, id: string): Promise<{ id: string; isRead: true; readAt: string }> {
    const readAt = await this.repo.markOneRead(id, actor.userId, actor.companyId);
    if (readAt === null) throw new NotFoundException('Notification not found');
    await this.pushUnreadBestEffort(actor.userId, actor.companyId);
    return { id, isRead: true, readAt: readAt.toISOString() };
  }

  /** Mark all (optionally one type) of the caller's unread notifications read; pushes the new count. */
  async markAllRead(actor: Actor, type?: string): Promise<{ updated: number }> {
    const updated = await this.repo.markAllRead(actor.userId, actor.companyId, type);
    await this.pushUnreadBestEffort(actor.userId, actor.companyId);
    return { updated };
  }

  private async pushUnreadBestEffort(userId: string, companyId: string): Promise<void> {
    try {
      const unread = await this.repo.unreadCount(companyId, userId);
      await this.pusher.pushUnreadCount(userId, companyId, unread);
    } catch (err) {
      this.logger.warn(`unread-count push failed for ${userId}: ${(err as Error).message}`);
    }
  }

  /** Push new + unread-count to the recipient's sockets; swallow any failure (FR-NTF-011/012). */
  private async pushBestEffort(record: NotificationRecord): Promise<void> {
    try {
      await this.pusher.pushNew(record.recipientUserId, record.companyId, viewFromRecord(record));
      const unread = await this.repo.unreadCount(record.companyId, record.recipientUserId);
      await this.pusher.pushUnreadCount(record.recipientUserId, record.companyId, unread);
    } catch (err) {
      // Best-effort: the persisted feed is authoritative; the client reconciles on reconnect.
      this.logger.warn(`push failed for notification ${record.id}: ${(err as Error).message}`);
    }
  }
}

/** A fresh (unread) view of a just-created record for the live push. The authoritative row is in the DB. */
function viewFromRecord(r: NotificationRecord): NotificationView {
  return {
    id: r.id,
    type: r.type,
    severity: r.severity,
    title: r.title,
    body: r.body,
    sourceModule: r.sourceModule,
    sourceEntityType: r.sourceEntityType,
    sourceEntityId: r.sourceEntityId,
    deepLink: r.deepLink,
    payload: r.payload,
    isRead: false,
    readAt: null,
    createdAt: new Date().toISOString(),
  };
}
