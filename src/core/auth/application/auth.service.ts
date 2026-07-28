/**
 * AuthService — authentication use cases (AUD application layer, PURE: no NestJS decorators
 * except @Injectable). Implements login / refresh / logout / changePassword (FR-AUD-001..006/008/009).
 * Account lockout: 5 consecutive failures → 15-min lock; uniform INVALID_CREDENTIALS in all failure
 * paths so email-enumeration and lockout are not disclosed (FR-AUD-001/009, §6 business rule).
 */
import { Inject, Injectable, ForbiddenException, Optional } from '@nestjs/common';
import { InvalidCredentialsError, ValidationError } from '../../../common/errors/domain-error';
import { PasswordHasher, PASSWORD_HASHER } from '../domain/ports/password-hasher.port';
import { TokenSigner, TOKEN_SIGNER, AccessClaims } from '../domain/ports/token-signer.port';
import { RefreshTokenStore, REFRESH_TOKEN_STORE } from '../domain/ports/refresh-token-store.port';
import { UserRepository, USER_REPOSITORY } from '../domain/ports/user.repository.port';
import { EventPublisher, EVENT_PUBLISHER } from '../../../common/ports/driven-ports';
import { AuthEvents } from '../domain/auth-events';
import { User } from '../domain/user';
import { RoleName } from '../domain/role';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResult extends TokenPair {
  user: {
    id: string;
    email: string;
    name: string;
    role: RoleName;
    companyId: string;
    financialYearId: string;
    isActive: boolean;
    lastLoginAt: Date | null;
    mustChangePassword: boolean;
    /**
     * Profile-photo CDN URL, or null when none (FR-AUD-038; contract 05 login response).
     * Returned at login so a client caching the safe `user` paints the shell avatar on
     * first render instead of flashing initials until `GET /api/auth/me` resolves. The
     * asset's `avatarPublicId` is NEVER exposed (FR-AUD-043), and this is read-only —
     * the avatar is set only via POST/DELETE /api/profile/image.
     */
    avatarUrl: string | null;
  };
}

const ACCESS_TOKEN_TTL_SECONDS = 900; // 15 min

@Injectable()
export class AuthService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(REFRESH_TOKEN_STORE) private readonly store: RefreshTokenStore,
    // Out-of-band notification producer — @Optional so existing constructors/tests are unaffected.
    @Optional() @Inject(EVENT_PUBLISHER) private readonly events?: EventPublisher,
  ) {}

  /** FR-AUD-001/008/009 — lockout (§16): uniform error for all failure paths. */
  async login(companyId: string, email: string, password: string): Promise<LoginResult> {
    const now = new Date();
    const user = await this.users.findByEmail(companyId, email);

    // Generic failure for unknown email — same path as wrong-password/deactivated.
    if (!user) {
      throw new InvalidCredentialsError();
    }

    // Lockout check before anything else — not disclosed (FR-AUD-001, §16).
    if (user.isLockedOut(now)) {
      throw new InvalidCredentialsError();
    }

    // Deactivated user → uniform error (FR-AUD-009).
    if (!user.props.isActive) {
      throw new InvalidCredentialsError();
    }

    const valid = await this.hasher.verify(password, user.props.passwordHash);
    if (!valid) {
      const wasLocked = user.isLockedOut(now);
      user.recordFailedLogin(now);
      await this.users.save(user);
      // Notify on the transition into a locked state (the 5th consecutive failure) — best-effort.
      if (!wasLocked && user.isLockedOut(now)) {
        try { await this.events?.publish([AuthEvents.accountLockedOut(user.props.companyId, user.id)]); } catch { /* best-effort */ }
      }
      throw new InvalidCredentialsError();
    }

    // Success: reset lockout, stamp last_login_at (FR-AUD-008).
    user.recordSuccessfulLogin(now);
    await this.users.save(user);

    // Resolve the real company from the found user — the `companyId` param is empty
    // on the normal login path (the client sends only email+password; findByEmail
    // resolves the user globally in Phase-1 single-company). Using the empty param
    // here would write "" into the refresh_token.company_id uuid column (crash) and
    // mint a refresh token with an empty company claim.
    const resolvedCompanyId = user.props.companyId;

    const refreshExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const jti = await this.store.issue(user.id, resolvedCompanyId, refreshExpiresAt);

    const claims: AccessClaims = {
      sub: user.id,
      companyId: user.props.companyId,
      financialYearId: user.props.financialYearId,
      role: user.props.role,
    };
    const accessToken = this.signer.signAccess(claims);
    const refreshToken = this.signer.signRefresh({ sub: user.id, jti, companyId: resolvedCompanyId });

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.props.email,
        name: user.props.name,
        role: user.props.role,
        companyId: user.props.companyId,
        financialYearId: user.props.financialYearId,
        isActive: user.props.isActive,
        lastLoginAt: user.props.lastLoginAt,
        mustChangePassword: user.props.mustChangePassword,
        avatarUrl: user.props.avatarUrl,
      },
    };
  }

  /** FR-AUD-004 — refresh: valid non-revoked JTI → new access token. */
  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    let claims;
    try {
      claims = this.signer.verifyRefresh(refreshToken);
    } catch {
      throw new InvalidCredentialsError();
    }

    const live = await this.store.isLive(claims.jti);
    if (!live) {
      throw new InvalidCredentialsError();
    }

    const user = await this.users.findById(claims.sub);
    if (!user || !user.props.isActive) {
      throw new ForbiddenException('FORBIDDEN');
    }

    const accessToken = this.signer.signAccess({
      sub: user.id,
      companyId: user.props.companyId,
      financialYearId: user.props.financialYearId,
      role: user.props.role,
    });

    return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  /** FR-AUD-005 — logout: revoke presented JTI. Idempotent (204 even if already revoked). */
  async logout(refreshToken: string): Promise<void> {
    let claims;
    try {
      claims = this.signer.verifyRefresh(refreshToken);
    } catch {
      return; // invalid token → treat as already logged out
    }
    await this.store.revoke(claims.jti);
  }

  /** FR-AUD-006/002 — change password: verify current, re-hash new, revoke all sessions. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new InvalidCredentialsError();

    const valid = await this.hasher.verify(currentPassword, user.props.passwordHash);
    if (!valid) throw new InvalidCredentialsError();

    if (newPassword.length < 10) {
      throw new ValidationError('Password must include letters and numbers.', {
        newPassword: ['Password must be at least 10 characters'],
      });
    }

    const newHash = await this.hasher.hash(newPassword);
    user.changePasswordHash(newHash);
    user.clearMustChangePassword(); // forced-change gate satisfied (FR-AUD-030)
    await this.users.save(user);
    await this.store.revokeAllFor(userId);
  }

  /** Used by JwtStrategy.validate() — re-checks is_active on every request (FR-AUD-009). */
  async validateUserById(userId: string): Promise<User | null> {
    const user = await this.users.findById(userId);
    if (!user || !user.props.isActive) return null;
    return user;
  }
}
