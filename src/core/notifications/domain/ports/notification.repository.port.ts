/** NotificationRepository port — write side (NTF domain). Company-scoped; idempotent insert. */
import { NotificationRecord } from '../notification-record';

export interface NotificationRepository {
  /** Insert one recipient's row; returns false (no-op) if (recipient_user_id, event_key) already exists (FR-NTF-019). */
  insertIfAbsent(record: NotificationRecord): Promise<boolean>;
  /** Mark one own notification read (idempotent). Returns its read_at, or null if it does not exist for this recipient (→ 404). */
  markOneRead(id: string, recipientUserId: string, companyId: string): Promise<Date | null>;
  /** Mark all (optionally of one type) unread notifications read; returns the number updated. */
  markAllRead(recipientUserId: string, companyId: string, type?: string): Promise<number>;
  /** The recipient's current unread count (for the push after emit/read — FR-NTF-010). */
  unreadCount(companyId: string, recipientUserId: string): Promise<number>;
}
export const NOTIFICATION_REPOSITORY = Symbol('NotificationRepository');
