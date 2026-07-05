/**
 * AUD domain events (PURE) — published on the in-process bus AFTER an auth/RBAC use case commits, so a
 * consumer (NTF) can raise a notification without AUD importing NTF (cycle-free — SRS 18 §16). Each is a
 * `DomainEvent` (name + occurredAt) plus a small payload; NTF maps the name → an Appendix-A notification.
 */
import { DomainEvent } from '../../../common/domain/domain';

export const AUTH_EVENTS = {
  USER_DEACTIVATED: 'aud.UserDeactivated',
  PASSWORD_RESET_FORCED: 'aud.PasswordResetForced',
  USER_CREATED_WELCOME: 'aud.UserCreatedWelcome',
  ROLE_PERMISSIONS_CHANGED: 'aud.RolePermissionsChanged',
  ACCOUNT_LOCKED_OUT: 'aud.AccountLockedOut',
} as const;

export interface AuthEvent extends DomainEvent {
  readonly companyId: string;
  /** The affected user (the account the event is about). */
  readonly userId: string;
  /** The admin who performed the action, where applicable. */
  readonly by?: string;
  readonly email?: string;
}

function make(name: string, companyId: string, userId: string, extra?: { by?: string; email?: string }): AuthEvent {
  return { name, occurredAt: new Date(), companyId, userId, ...extra };
}

export const AuthEvents = {
  userDeactivated: (companyId: string, userId: string, by: string) => make(AUTH_EVENTS.USER_DEACTIVATED, companyId, userId, { by }),
  passwordResetForced: (companyId: string, userId: string, by: string) => make(AUTH_EVENTS.PASSWORD_RESET_FORCED, companyId, userId, { by }),
  userCreatedWelcome: (companyId: string, userId: string, email: string) => make(AUTH_EVENTS.USER_CREATED_WELCOME, companyId, userId, { email }),
  rolePermissionsChanged: (companyId: string, userId: string, by: string) => make(AUTH_EVENTS.ROLE_PERMISSIONS_CHANGED, companyId, userId, { by }),
  accountLockedOut: (companyId: string, userId: string) => make(AUTH_EVENTS.ACCOUNT_LOCKED_OUT, companyId, userId),
};
