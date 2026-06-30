/**
 * User domain unit tests — lockout logic, password change, activate/deactivate.
 * No DB, no NestJS (FR-AUD-001/009, §16 password policy).
 */
import { User } from '../../../src/core/auth/domain/user';

function baseUser(overrides?: Partial<{ isActive: boolean; failedLoginAttempts: number; lockedUntil: Date | null }>): User {
  return User.rehydrate('u-1', {
    companyId: 'co-1', financialYearId: 'fy-1', email: 'a@b.com',
    passwordHash: 'h', name: 'N', role: 'ADMIN',
    isActive: overrides?.isActive ?? true,
    lastLoginAt: null, phone: null,
    failedLoginAttempts: overrides?.failedLoginAttempts ?? 0,
    lockedUntil: overrides?.lockedUntil ?? null,
    version: 1,
  });
}

const NOW = new Date('2026-06-30T00:00:00Z');

describe('User (domain)', () => {
  it('User.create builds an active user with required fields', () => {
    const u = User.create('u-1', {
      companyId: 'co-1', financialYearId: 'fy-1',
      email: 'Test@Example.Com', passwordHash: 'h',
      name: 'Test', role: 'ADMIN',
    });
    expect(u.props.email).toBe('test@example.com');
    expect(u.props.isActive).toBe(true);
    expect(u.props.failedLoginAttempts).toBe(0);
  });

  it('isLockedOut: false when no lockedUntil', () => {
    expect(baseUser().isLockedOut(NOW)).toBe(false);
  });

  it('isLockedOut: true when lockedUntil is in the future', () => {
    const futurelock = new Date(NOW.getTime() + 60_000);
    expect(baseUser({ lockedUntil: futurelock }).isLockedOut(NOW)).toBe(true);
  });

  it('isLockedOut: false when lockedUntil has passed', () => {
    const past = new Date(NOW.getTime() - 1);
    expect(baseUser({ lockedUntil: past }).isLockedOut(NOW)).toBe(false);
  });

  it('recordFailedLogin increments counter', () => {
    const u = baseUser({ failedLoginAttempts: 3 });
    u.recordFailedLogin(NOW);
    expect(u.props.failedLoginAttempts).toBe(4);
    expect(u.props.lockedUntil).toBeNull();
  });

  it('recordFailedLogin on 5th attempt sets lockedUntil ~15 min from now', () => {
    const u = baseUser({ failedLoginAttempts: 4 });
    u.recordFailedLogin(NOW);
    expect(u.props.failedLoginAttempts).toBe(5);
    expect(u.props.lockedUntil).not.toBeNull();
    const diff = u.props.lockedUntil!.getTime() - NOW.getTime();
    expect(diff).toBeGreaterThanOrEqual(14 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(16 * 60 * 1000);
  });

  it('recordSuccessfulLogin resets counter and sets lastLoginAt', () => {
    const u = baseUser({ failedLoginAttempts: 3, lockedUntil: new Date(NOW.getTime() + 1000) });
    u.recordSuccessfulLogin(NOW);
    expect(u.props.failedLoginAttempts).toBe(0);
    expect(u.props.lockedUntil).toBeNull();
    expect(u.props.lastLoginAt).toEqual(NOW);
  });

  it('changePasswordHash updates the hash', () => {
    const u = baseUser();
    u.changePasswordHash('new-hash');
    expect(u.props.passwordHash).toBe('new-hash');
  });

  it('deactivate / activate toggle isActive', () => {
    const u = baseUser();
    u.deactivate();
    expect(u.props.isActive).toBe(false);
    u.activate();
    expect(u.props.isActive).toBe(true);
  });
});
