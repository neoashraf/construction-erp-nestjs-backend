/**
 * NotificationsModule (NTF · ntf-foundation) — the in-app notification substrate. Wires the emit service,
 * the REST feed query service + controller, the WebSocket gateway (also the NotificationPusher adapter),
 * the notification repository, and the recipient resolver. Imports AuthModule for the guards + TokenSigner
 * (socket handshake) + role/user-project access (recipient resolution reads AUD tables via DATA_SOURCE).
 * `ID_GENERATOR` / `DATA_SOURCE` are provided globally. Exports `NotificationService` so producer briefs
 * (ntf-producers / ntf-scheduler) can inject the `emit` seam.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationService } from './application/notification.service';
import { NotificationSubscriber } from './application/notification-subscriber';
import { NtfSchedulerService } from './application/ntf-scheduler.service';
import { NotificationsQueryService } from './read/notifications.query-service';
import { NtfDueQueryService } from './read/ntf-due.query-service';
import { NotificationsController } from './presentation/notifications.controller';
import { NotificationsGateway } from './presentation/notifications.gateway';
import { TypeOrmNotificationRepository } from './infrastructure/typeorm-notification.repository';
import { SqlRecipientResolver } from './infrastructure/sql-recipient-resolver';
import { NOTIFICATION_REPOSITORY } from './domain/ports/notification.repository.port';
import { RECIPIENT_RESOLVER } from './domain/ports/recipient-resolver.port';
import { NOTIFICATION_PUSHER } from './domain/ports/notification-pusher.port';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [
    NotificationService,
    NotificationSubscriber,
    NtfSchedulerService,
    NotificationsQueryService,
    NtfDueQueryService,
    NotificationsGateway,
    { provide: NOTIFICATION_REPOSITORY, useClass: TypeOrmNotificationRepository },
    { provide: RECIPIENT_RESOLVER, useClass: SqlRecipientResolver },
    { provide: NOTIFICATION_PUSHER, useExisting: NotificationsGateway },
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
