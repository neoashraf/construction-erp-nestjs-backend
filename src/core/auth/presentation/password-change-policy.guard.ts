/**
 * PasswordChangePolicyGuard (PRESENTATION) — the global forced first-login change gate (FR-AUD-030).
 *
 * Registered platform-wide via APP_GUARD (like the response envelope), it runs on every request. When
 * the caller's loaded user has `must_change_password = true`, it rejects with `PASSWORD_CHANGE_REQUIRED`
 * (403) UNLESS the route is on the allow-list — the four endpoints a forced user must still reach to
 * recover: GET /api/auth/me, POST /api/auth/change-password, POST /api/auth/refresh, POST /api/auth/logout.
 *
 * Because APP_GUARD runs BEFORE the per-controller JwtAuthGuard, `request.user` is not yet populated, so
 * this guard verifies the bearer access token itself (cheaply) to load the flag. It NEVER performs
 * authorization: an absent/invalid token → pass through (the downstream JwtAuthGuard issues 401 or the
 * route is public). The must_change_password flag is read live from the DB (not the token) so a change
 * that clears it takes effect immediately, without waiting for token expiry.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../application/auth.service';
import { TokenSigner, TOKEN_SIGNER } from '../domain/ports/token-signer.port';

const ALLOW_LIST = new Set<string>([
  'GET /api/auth/me',
  'POST /api/auth/change-password',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
]);

@Injectable()
export class PasswordChangePolicyGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const path = (req.path ?? req.url ?? '').split('?')[0].replace(/\/+$/, '') || '/';
    if (ALLOW_LIST.has(`${req.method} ${path}`)) return true;

    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw || !raw.startsWith('Bearer ')) return true; // no token → downstream JwtAuthGuard handles it

    let sub: string;
    try {
      sub = this.signer.verifyAccess(raw.slice(7)).sub;
    } catch {
      return true; // invalid/expired token → let the downstream JwtAuthGuard reject with 401
    }

    const user = await this.auth.validateUserById(sub);
    if (user?.props.mustChangePassword) {
      throw new ForbiddenException('PASSWORD_CHANGE_REQUIRED');
    }
    return true;
  }
}
