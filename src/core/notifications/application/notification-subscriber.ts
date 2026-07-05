/**
 * NotificationSubscriber (NTF application — SRS 18 §16 ingestion). On module init it subscribes to the
 * in-process event bus and maps each known domain event → an `EmitCommand`, then calls
 * `NotificationService.emit`. Producers publish after their own commit; this bridge (and emit) are
 * out-of-band + best-effort, so nothing here can affect a producer's business transaction (FR-NTF-012/016).
 *
 * Currently maps the AUD security events (from `#41 ntf-producers`); voucher-lifecycle events map here
 * too as their modules start publishing (same pattern, keyed by event name).
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EventSubscriber, EVENT_SUBSCRIBER } from '../../../common/ports/driven-ports';
import { DomainEvent } from '../../../common/domain/domain';
import { NotificationService } from './notification.service';
import { EmitCommand } from '../domain/notification-record';
import { AUTH_EVENTS, AuthEvent } from '../../auth/domain/auth-events';

@Injectable()
export class NotificationSubscriber implements OnModuleInit {
  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly bus: EventSubscriber,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(event => this.handle(event));
  }

  /** Map a known event → emit; unknown events are ignored (other consumers may handle them). */
  private async handle(event: DomainEvent): Promise<void> {
    const command = this.toCommand(event);
    if (command) await this.notifications.emit(command);
  }

  private toCommand(event: DomainEvent): EmitCommand | null {
    const key = (suffix: string) => `${event.name}:${suffix}:${event.occurredAt.getTime()}`;

    switch (event.name) {
      case AUTH_EVENTS.USER_DEACTIVATED: {
        const e = event as AuthEvent;
        return {
          type: 'USER_DEACTIVATED', companyId: e.companyId, affectedUserId: e.userId,
          title: 'Your account was deactivated',
          body: 'An administrator deactivated your account. Contact your admin if this is unexpected.',
          sourceEntityType: 'User', sourceEntityId: e.userId, eventKey: key(e.userId),
        };
      }
      case AUTH_EVENTS.PASSWORD_RESET_FORCED: {
        const e = event as AuthEvent;
        return {
          type: 'PASSWORD_RESET_FORCED', companyId: e.companyId, affectedUserId: e.userId,
          title: 'Password reset — change required',
          body: 'Your password was reset by an administrator. You must set a new password at next sign-in.',
          sourceEntityType: 'User', sourceEntityId: e.userId, eventKey: key(e.userId),
        };
      }
      case AUTH_EVENTS.USER_CREATED_WELCOME: {
        const e = event as AuthEvent;
        return {
          type: 'USER_CREATED_WELCOME', companyId: e.companyId, affectedUserId: e.userId,
          title: 'Welcome to Zakir Enterprise ERP',
          body: 'Your account has been created. Set your password at first sign-in to get started.',
          sourceEntityType: 'User', sourceEntityId: e.userId, eventKey: key(e.userId),
        };
      }
      case AUTH_EVENTS.ROLE_PERMISSIONS_CHANGED: {
        const e = event as AuthEvent;
        return {
          type: 'ROLE_PERMISSIONS_CHANGED', companyId: e.companyId, affectedUserId: e.userId,
          title: 'Your access has changed',
          body: 'An administrator updated your role or permissions. Your available actions may have changed.',
          sourceEntityType: 'User', sourceEntityId: e.userId, eventKey: key(e.userId),
        };
      }
      case AUTH_EVENTS.ACCOUNT_LOCKED_OUT: {
        const e = event as AuthEvent;
        return {
          type: 'ACCOUNT_LOCKED_OUT', companyId: e.companyId, affectedUserId: e.userId,
          title: 'Account locked after failed sign-ins',
          body: 'Your account was temporarily locked after repeated failed sign-in attempts.',
          sourceEntityType: 'User', sourceEntityId: e.userId, eventKey: key(e.userId),
        };
      }
      default:
        return null;
    }
  }
}
