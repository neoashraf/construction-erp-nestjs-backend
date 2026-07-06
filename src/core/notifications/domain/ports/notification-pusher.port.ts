/**
 * NotificationPusher port — the live (best-effort) delivery channel (NTF, FR-NTF-007/010). The WebSocket
 * gateway is the adapter; the application depends only on this interface. Pushes are best-effort: the
 * persisted feed is authoritative, so a push failure must never propagate (FR-NTF-011/012).
 */
import { NotificationView } from '../../read/dto/notification-view.dto';

export interface NotificationPusher {
  /** Push a new notification to the recipient's connected sockets. */
  pushNew(userId: string, companyId: string, notification: NotificationView): Promise<void>;
  /** Push the recipient's updated unread count to their connected sockets. */
  pushUnreadCount(userId: string, companyId: string, unreadCount: number): Promise<void>;
}
export const NOTIFICATION_PUSHER = Symbol('NotificationPusher');
