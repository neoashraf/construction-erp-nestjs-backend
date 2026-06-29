/**
 * @CurrentActor() — resolves the request `Actor` (skill §9). PRESENTATION.
 *
 * TEMP SEAM: the real JWT auth (strategy + guard that sets `request.user`) is owned by AUD and lands
 * in the `auth-jwt` brief. Until then this decorator:
 *   1. returns `request.user` when present (future JWT path — zero change needed when auth lands), else
 *   2. OUTSIDE production only, synthesises an Actor from `x-company-id` / `x-user-id` / `x-role` /
 *      `x-financial-year-id` headers so MAS is exercisable end-to-end in dev/tests.
 * In production with no authenticated user it throws 401 — the header fallback never applies there.
 * The company is taken from the token/header context, NEVER from the request body (FR-MAS-001).
 */
import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Actor } from '../../../core/tenancy/tenant-context';

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function resolveActor(req: Request): Actor {
  const fromAuth = (req as Request & { user?: Actor }).user;
  if (fromAuth) return fromAuth;

  if (process.env.NODE_ENV === 'production') {
    throw new UnauthorizedException('Authentication required');
  }

  const companyId = header(req, 'x-company-id');
  if (!companyId) {
    throw new UnauthorizedException(
      'No authenticated actor (auth-jwt not yet wired; supply x-company-id header in dev)',
    );
  }
  return {
    userId: header(req, 'x-user-id') ?? 'dev-user',
    companyId,
    financialYearId: header(req, 'x-financial-year-id') ?? '',
    role: header(req, 'x-role') ?? 'Admin',
  };
}

export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor => resolveActor(ctx.switchToHttp().getRequest<Request>()),
);
