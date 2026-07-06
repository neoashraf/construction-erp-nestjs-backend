/**
 * NotificationRecord + emit command (NTF domain — PURE). A notification is a lean append-only record
 * (its only mutation is read-state), so NTF uses a factory + typed record rather than a rich aggregate
 * (nestjs-author §2.3 — ceremony scales with complexity). The catalogue supplies severity + source;
 * the caller supplies the title/body/refs/payload/eventKey.
 */
import { Severity, NotificationTypeDef } from './notification-catalog';

export interface DeepLink {
  route: string;
  params?: Record<string, unknown>;
}

/** The command a producer hands `NotificationService.emit(...)` (SRS 18 §4 / API "Not endpoints"). */
export interface EmitCommand {
  /** Notification Type Catalogue code — validated on emit (FR-NTF-021). */
  type: string;
  companyId: string;
  title: string;
  body: string;
  /** The record the notification is about (defaults sourceModule to the catalogue's). */
  sourceModule?: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  /** For PROJECT_ROLE rules — scopes recipients to holders assigned to this project. */
  projectId?: string | null;
  /** For USER rules — the affected user. */
  affectedUserId?: string | null;
  deepLink?: DeepLink | null;
  payload?: Record<string, unknown>;
  /** Idempotency key (the source event id); at most one row per (recipient, eventKey) — FR-NTF-019. */
  eventKey: string;
}

/** A persisted notification, one per recipient (fan-out — FR-NTF-002). */
export interface NotificationRecord {
  id: string;
  companyId: string;
  recipientUserId: string;
  type: string;
  severity: Severity;
  title: string;
  body: string;
  sourceModule: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  deepLink: DeepLink | null;
  payload: Record<string, unknown>;
  eventKey: string;
}

/** Build one recipient's record from a validated command + its catalogue entry (FR-NTF-001). */
export function buildNotificationRecord(
  id: string,
  recipientUserId: string,
  command: EmitCommand,
  def: NotificationTypeDef,
): NotificationRecord {
  if (!command.title.trim()) throw new Error('Notification title is required');
  if (!command.eventKey.trim()) throw new Error('Notification eventKey is required');
  return {
    id,
    companyId: command.companyId,
    recipientUserId,
    type: def.code,
    severity: def.severity,
    title: command.title,
    body: command.body,
    sourceModule: command.sourceModule ?? def.sourceModule,
    sourceEntityType: command.sourceEntityType ?? null,
    sourceEntityId: command.sourceEntityId ?? null,
    deepLink: command.deepLink ?? null,
    payload: command.payload ?? {},
    eventKey: command.eventKey,
  };
}
