/**
 * LoggingNotificationAdapter (INFRASTRUCTURE) — implements NotificationPort. REQ's job is to TRIGGER the
 * notification with the correct recipient at each transition (submit/approve/reject/close); the delivery
 * channel (SMS is a primary channel — overview §9 — or in-app) is AUD/platform. Phase-1 binds a logging
 * adapter so the trigger is recorded and testable; when AUD exposes a notification service, rebind here —
 * the port + use cases stay unchanged (FR-REQ-007/-023).
 */
import { Injectable, Logger } from '@nestjs/common';
import { NotificationPort, RequisitionNotification } from '../domain/ports/notification.port';

@Injectable()
export class LoggingNotificationAdapter implements NotificationPort {
  private readonly logger = new Logger('RequisitionNotification');

  async notify(notification: RequisitionNotification): Promise<void> {
    this.logger.log(
      `event=${notification.event} requisition=${notification.requisitionId} ` +
        `project=${notification.projectId} recipients=${notification.recipients.join(',')}`,
    );
  }
}
