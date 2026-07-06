/**
 * NotificationView (NTF read/) — the Notification resource returned by the REST feed and pushed over the
 * socket. camelCase; money inside `payload` is a Decimal(18,4) string; no secrets. (SRS 18 §8, API 18.)
 */
import { Severity } from '../../domain/notification-catalog';
import { DeepLink } from '../../domain/notification-record';

export interface NotificationView {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  body: string;
  sourceModule: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  deepLink: DeepLink | null;
  payload: Record<string, unknown>;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}
