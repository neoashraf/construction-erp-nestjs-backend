/**
 * NotificationSubscriber unit tests (#41) — maps AUD domain events → NotificationService.emit commands.
 */
import { NotificationSubscriber } from '../../../src/core/notifications/application/notification-subscriber';
import { AuthEvents } from '../../../src/core/auth/domain/auth-events';
import { EmitCommand } from '../../../src/core/notifications/domain/notification-record';

describe('NotificationSubscriber', () => {
  let handler: (e: any) => Promise<void>;
  const bus = { subscribe: (h: any) => { handler = h; } } as any;
  const emits: EmitCommand[] = [];
  const notifications = { emit: async (c: EmitCommand) => { emits.push(c); return { created: 1 }; } } as any;

  beforeEach(() => { emits.length = 0; new NotificationSubscriber(bus, notifications).onModuleInit(); });

  it('registers a bus handler on init', () => {
    expect(typeof handler).toBe('function');
  });

  it('maps UserDeactivated → USER_DEACTIVATED emit (affected user)', async () => {
    await handler(AuthEvents.userDeactivated('co-1', 'u-9', 'admin-1'));
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({ type: 'USER_DEACTIVATED', companyId: 'co-1', affectedUserId: 'u-9' });
    expect(emits[0].eventKey).toContain('u-9');
  });

  it('maps each AUD security event to its notification type', async () => {
    await handler(AuthEvents.passwordResetForced('co-1', 'u-1', 'admin-1'));
    await handler(AuthEvents.userCreatedWelcome('co-1', 'u-2', 'x@y.z'));
    await handler(AuthEvents.rolePermissionsChanged('co-1', 'u-3', 'admin-1'));
    await handler(AuthEvents.accountLockedOut('co-1', 'u-4'));
    expect(emits.map(e => e.type)).toEqual([
      'PASSWORD_RESET_FORCED', 'USER_CREATED_WELCOME', 'ROLE_PERMISSIONS_CHANGED', 'ACCOUNT_LOCKED_OUT',
    ]);
  });

  it('ignores an unknown event (no emit)', async () => {
    await handler({ name: 'some.OtherEvent', occurredAt: new Date() });
    expect(emits).toHaveLength(0);
  });
});
