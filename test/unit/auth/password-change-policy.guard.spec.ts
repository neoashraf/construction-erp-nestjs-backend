/**
 * PasswordChangePolicyGuard unit tests (FR-AUD-030) — the global forced-change gate + allow-list.
 * Verifies: allow-listed routes always pass; no/invalid token passes through (downstream JwtAuthGuard
 * handles auth); a must_change_password user is 403 PASSWORD_CHANGE_REQUIRED on any other route; a
 * cleared user passes.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PasswordChangePolicyGuard } from '../../../src/core/auth/presentation/password-change-policy.guard';
import { TokenSigner } from '../../../src/core/auth/domain/ports/token-signer.port';

function ctx(method: string, path: string, authHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, path, headers: authHeader ? { authorization: authHeader } : {} }) }),
  } as unknown as ExecutionContext;
}

function makeGuard(opts: { sub?: string; verifyThrows?: boolean; mustChange?: boolean | null }) {
  const signer: TokenSigner = {
    signAccess: () => '',
    signRefresh: () => '',
    verifyRefresh: () => ({ sub: '', jti: '', companyId: '' }),
    verifyAccess: () => {
      if (opts.verifyThrows) throw new Error('bad token');
      return { sub: opts.sub ?? 'u1', companyId: 'c1', financialYearId: 'fy1', role: 'ADMIN' };
    },
  };
  const auth = {
    validateUserById: async () =>
      opts.mustChange === null ? null : ({ props: { mustChangePassword: opts.mustChange } } as any),
  } as any;
  return new PasswordChangePolicyGuard(signer, auth);
}

describe('PasswordChangePolicyGuard (FR-AUD-030)', () => {
  it('allows an allow-listed route even for a must-change user (GET /api/auth/me)', async () => {
    const guard = makeGuard({ mustChange: true });
    await expect(guard.canActivate(ctx('GET', '/api/auth/me', 'Bearer x'))).resolves.toBe(true);
  });

  it.each([
    ['POST', '/api/auth/change-password'],
    ['POST', '/api/auth/refresh'],
    ['POST', '/api/auth/logout'],
  ])('allows allow-listed %s %s', async (method, path) => {
    const guard = makeGuard({ mustChange: true });
    await expect(guard.canActivate(ctx(method, path, 'Bearer x'))).resolves.toBe(true);
  });

  it('passes through when no bearer token is present (downstream JwtAuthGuard handles auth)', async () => {
    const guard = makeGuard({ mustChange: true });
    await expect(guard.canActivate(ctx('GET', '/api/users'))).resolves.toBe(true);
  });

  it('passes through on an invalid/expired token (downstream JwtAuthGuard issues 401)', async () => {
    const guard = makeGuard({ verifyThrows: true, mustChange: true });
    await expect(guard.canActivate(ctx('GET', '/api/users', 'Bearer bad'))).resolves.toBe(true);
  });

  it('403 PASSWORD_CHANGE_REQUIRED for a must-change user on a non-allow-listed route', async () => {
    const guard = makeGuard({ mustChange: true });
    await expect(guard.canActivate(ctx('GET', '/api/users', 'Bearer x'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx('GET', '/api/users', 'Bearer x'))).rejects.toMatchObject({ message: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('allows a user whose flag is cleared', async () => {
    const guard = makeGuard({ mustChange: false });
    await expect(guard.canActivate(ctx('GET', '/api/users', 'Bearer x'))).resolves.toBe(true);
  });

  it('ignores a trailing slash when matching the allow-list', async () => {
    const guard = makeGuard({ mustChange: true });
    await expect(guard.canActivate(ctx('GET', '/api/auth/me/', 'Bearer x'))).resolves.toBe(true);
  });
});
