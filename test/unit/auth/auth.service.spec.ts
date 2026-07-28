/**
 * AuthService unit tests — no DB, no NestJS DI. All auth use cases with fake ports.
 * Covers FR-AUD-001/002/004/005/006/008/009 and §16 lockout (5 attempts / 15-min window).
 */
import { ForbiddenException } from '@nestjs/common';
import { InvalidCredentialsError, ValidationError } from '../../../src/common/errors/domain-error';
import { AuthService } from '../../../src/core/auth/application/auth.service';
import { User } from '../../../src/core/auth/domain/user';
import { PasswordHasher } from '../../../src/core/auth/domain/ports/password-hasher.port';
import { TokenSigner, AccessClaims, RefreshClaims } from '../../../src/core/auth/domain/ports/token-signer.port';
import { RefreshTokenStore } from '../../../src/core/auth/domain/ports/refresh-token-store.port';
import { UserRepository } from '../../../src/core/auth/domain/ports/user.repository.port';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides?: Partial<{
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  avatarUrl: string | null;
  name: string;
}>): User {
  return User.rehydrate('user-1', {
    companyId: 'co-1',
    financialYearId: 'fy-1',
    email: 'admin@test.com',
    passwordHash: 'hashed-secret',
    name: overrides?.name ?? 'Test User',
    role: 'ADMIN',
    isActive: overrides?.isActive ?? true,
    mustChangePassword: false,
    lastLoginAt: null,
    phone: null,
    avatarUrl: overrides?.avatarUrl ?? null,
    avatarPublicId: null,
    failedLoginAttempts: overrides?.failedLoginAttempts ?? 0,
    lockedUntil: overrides?.lockedUntil ?? null,
    version: 1,
  });
}

function makeHasher(valid: boolean): PasswordHasher {
  return {
    hash: async (p) => `hash(${p})`,
    verify: async () => valid,
  };
}

function makeSigner(): TokenSigner {
  return {
    signAccess: (c: AccessClaims) => `access.${c.sub}`,
    signRefresh: (c: RefreshClaims) => `refresh.${c.jti}`,
    verifyAccess: (t: string) => {
      const sub = t.replace('access.', '');
      return { sub, companyId: 'co-1', financialYearId: 'fy-1', role: 'ADMIN' as const };
    },
    verifyRefresh: (t: string) => {
      const jti = t.replace('refresh.', '');
      return { sub: 'user-1', jti, companyId: 'co-1' };
    },
  };
}

function makeStore(liveJtis: Set<string> = new Set(['jti-1'])): RefreshTokenStore {
  return {
    issue: async () => { liveJtis.add('jti-new'); return 'jti-new'; },
    isLive: async (jti) => liveJtis.has(jti),
    revoke: async (jti) => { liveJtis.delete(jti); },
    revokeAllFor: async () => { liveJtis.clear(); },
  };
}

function makeRepo(user?: User | null): UserRepository {
  let stored = user ?? null;
  return {
    findByEmail: async (_c, _e) => stored,
    findById: async (_id) => stored,
    save: async (u) => { stored = u; },
  };
}

function buildService(
  user: User | null,
  passwordValid: boolean,
  jtiStore: Set<string> = new Set(['jti-1']),
): AuthService {
  return new AuthService(
    makeRepo(user) as any,
    makeHasher(passwordValid) as any,
    makeSigner() as any,
    makeStore(jtiStore) as any,
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  describe('login', () => {
    it('issues token pair + sets last_login_at on success (FR-AUD-001/008)', async () => {
      const user = makeUser();
      const svc = buildService(user, true);
      const result = await svc.login('co-1', 'admin@test.com', 'secret');
      expect(result.accessToken).toMatch(/^access\./);
      expect(result.refreshToken).toMatch(/^refresh\./);
      expect(result.expiresIn).toBe(900);
      expect(result.user.lastLoginAt).not.toBeNull();
      expect(result.user.id).toBe('user-1');
    });

    // The shell's sidebar avatar paints from the cached safe `user` before
    // GET /api/auth/me resolves, so login must carry avatarUrl (FR-AUD-038,
    // contract 05). Omitting it flashed initials on every login.
    it('returns the caller avatarUrl on success (FR-AUD-038)', async () => {
      const url = 'https://res.cloudinary.com/zakir-erp/image/upload/v1/companies/co-1/avatars/user-1.webp';
      const svc = buildService(makeUser({ avatarUrl: url }), true);
      const result = await svc.login('co-1', 'admin@test.com', 'secret');
      expect(result.user.avatarUrl).toBe(url);
    });

    it('returns avatarUrl null when the caller has no photo (FR-AUD-038)', async () => {
      const svc = buildService(makeUser(), true);
      const result = await svc.login('co-1', 'admin@test.com', 'secret');
      expect(result.user.avatarUrl).toBeNull();
    });

    // FR-AUD-043 — the Cloudinary asset handle never leaves the server.
    it('never exposes avatarPublicId in the login response (FR-AUD-043)', async () => {
      const svc = buildService(makeUser({ avatarUrl: 'https://cdn.example/a.webp' }), true);
      const result = await svc.login('co-1', 'admin@test.com', 'secret');
      expect(result.user).not.toHaveProperty('avatarPublicId');
      expect(JSON.stringify(result)).not.toContain('avatarPublicId');
    });

    it('returns INVALID_CREDENTIALS for wrong password (FR-AUD-001)', async () => {
      const svc = buildService(makeUser(), false);
      await expect(svc.login('co-1', 'admin@test.com', 'wrong')).rejects.toThrow(InvalidCredentialsError);
    });

    it('returns INVALID_CREDENTIALS for unknown email — uniform error (FR-AUD-001)', async () => {
      const svc = buildService(null, false);
      await expect(svc.login('co-1', 'unknown@test.com', 'pass')).rejects.toThrow(InvalidCredentialsError);
    });

    it('returns INVALID_CREDENTIALS for deactivated user — not disclosed (FR-AUD-009)', async () => {
      const svc = buildService(makeUser({ isActive: false }), true);
      await expect(svc.login('co-1', 'admin@test.com', 'secret')).rejects.toThrow(InvalidCredentialsError);
    });

    it('increments failed_login_attempts on wrong password', async () => {
      const user = makeUser();
      const repo = makeRepo(user);
      const savedCapture: User[] = [];
      (repo as any).save = async (u: User) => { savedCapture.push(u); };
      const svc = new AuthService(repo as any, makeHasher(false) as any, makeSigner() as any, makeStore() as any);
      await expect(svc.login('co-1', 'admin@test.com', 'wrong')).rejects.toThrow(InvalidCredentialsError);
      expect(savedCapture[0]?.props.failedLoginAttempts).toBe(1);
    });

    it('locks account after 5 consecutive failures — §16 password policy (FR-AUD-001)', async () => {
      const user = makeUser({ failedLoginAttempts: 4 });
      const repo = makeRepo(user);
      const savedCapture: User[] = [];
      (repo as any).save = async (u: User) => { savedCapture.push(u); };
      const svc = new AuthService(repo as any, makeHasher(false) as any, makeSigner() as any, makeStore() as any);
      await expect(svc.login('co-1', 'admin@test.com', 'wrong')).rejects.toThrow(InvalidCredentialsError);
      expect(savedCapture[0]?.props.failedLoginAttempts).toBe(5);
      expect(savedCapture[0]?.props.lockedUntil).not.toBeNull();
    });

    it('returns INVALID_CREDENTIALS during lockout even with correct password (§16)', async () => {
      const lockedUntil = new Date(Date.now() + 60_000);
      const user = makeUser({ failedLoginAttempts: 5, lockedUntil });
      const svc = buildService(user, true); // correct password but locked
      await expect(svc.login('co-1', 'admin@test.com', 'secret')).rejects.toThrow(InvalidCredentialsError);
    });

    it('resets failed_login_attempts + lockedUntil on successful login after lockout window', async () => {
      const lockedUntil = new Date(Date.now() - 1); // expired 1ms ago
      const user = makeUser({ failedLoginAttempts: 5, lockedUntil });
      const repo = makeRepo(user);
      const savedCapture: User[] = [];
      (repo as any).save = async (u: User) => { savedCapture.push(u); };
      const svc = new AuthService(repo as any, makeHasher(true) as any, makeSigner() as any, makeStore() as any);
      await svc.login('co-1', 'admin@test.com', 'secret');
      expect(savedCapture[0]?.props.failedLoginAttempts).toBe(0);
      expect(savedCapture[0]?.props.lockedUntil).toBeNull();
    });
  });

  describe('refresh', () => {
    it('issues a new access token for a live JTI (FR-AUD-004)', async () => {
      const jtiStore = new Set(['jti-1']);
      const svc = buildService(makeUser(), true, jtiStore);
      const result = await svc.refresh('refresh.jti-1');
      expect(result.accessToken).toMatch(/^access\./);
      expect(result.expiresIn).toBe(900);
    });

    it('rejects a revoked JTI — INVALID_CREDENTIALS (FR-AUD-004)', async () => {
      const svc = buildService(makeUser(), true, new Set()); // no live jtis
      await expect(svc.refresh('refresh.jti-1')).rejects.toThrow(InvalidCredentialsError);
    });

    it('rejects an invalid refresh token string', async () => {
      // verifyRefresh throws on non-matching pattern
      const brokenSvc = new AuthService(
        makeRepo(makeUser()) as any,
        makeHasher(true) as any,
        { ...makeSigner(), verifyRefresh: () => { throw new Error('invalid'); } } as any,
        makeStore() as any,
      );
      await expect(brokenSvc.refresh('garbage')).rejects.toThrow(InvalidCredentialsError);
    });

    it('rejects refresh when user is now inactive (FR-AUD-009)', async () => {
      const jtiStore = new Set(['jti-1']);
      const svc = buildService(makeUser({ isActive: false }), true, jtiStore);
      await expect(svc.refresh('refresh.jti-1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('logout', () => {
    it('revokes the presented JTI (FR-AUD-005)', async () => {
      const jtiStore = new Set(['jti-1']);
      const svc = buildService(makeUser(), true, jtiStore);
      await svc.logout('refresh.jti-1');
      expect(jtiStore.has('jti-1')).toBe(false);
    });

    it('is idempotent — already-revoked token does not throw (FR-AUD-005, edge case 11)', async () => {
      const svc = buildService(makeUser(), true, new Set());
      await expect(svc.logout('refresh.jti-already-gone')).resolves.toBeUndefined();
    });
  });

  describe('changePassword', () => {
    it('re-hashes and revokes all sessions (FR-AUD-006/002)', async () => {
      const jtiStore = new Set(['jti-1', 'jti-2']);
      const user = makeUser();
      const repo = makeRepo(user);
      const savedCapture: User[] = [];
      (repo as any).save = async (u: User) => { savedCapture.push(u); };
      const svc = new AuthService(
        repo as any,
        { hash: async (p: string) => `newhash(${p})`, verify: async () => true } as any,
        makeSigner() as any,
        makeStore(jtiStore) as any,
      );
      await svc.changePassword('user-1', 'old-pass', 'new-pass-10chars');
      expect(savedCapture[0]?.props.passwordHash).toBe('newhash(new-pass-10chars)');
      expect(jtiStore.size).toBe(0);
    });

    it('rejects when current password is wrong — INVALID_CREDENTIALS (FR-AUD-006)', async () => {
      const svc = buildService(makeUser(), false);
      await expect(svc.changePassword('user-1', 'wrong', 'new-pass-10chars')).rejects.toThrow(InvalidCredentialsError);
    });

    it('rejects new password shorter than 10 chars — VALIDATION_ERROR', async () => {
      const svc = buildService(makeUser(), true);
      await expect(svc.changePassword('user-1', 'current', 'short')).rejects.toThrow(ValidationError);
    });
  });

  describe('validateUserById', () => {
    it('returns the user when active (for JwtStrategy.validate)', async () => {
      const svc = buildService(makeUser(), true);
      const user = await svc.validateUserById('user-1');
      expect(user?.id).toBe('user-1');
    });

    it('returns null for deactivated user (FR-AUD-009)', async () => {
      const svc = buildService(makeUser({ isActive: false }), true);
      expect(await svc.validateUserById('user-1')).toBeNull();
    });

    it('returns null for unknown userId', async () => {
      const svc = buildService(null, false);
      expect(await svc.validateUserById('no-such-id')).toBeNull();
    });
  });
});
