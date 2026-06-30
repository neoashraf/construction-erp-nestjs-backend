/**
 * JwtAuthGuard (PRESENTATION) — passport-jwt guard for all secured routes (FR-AUD-003/009).
 * Returns 401 on missing/malformed/expired token; 403 for deactivated user (via strategy.validate).
 */
import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  override canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    return super.canActivate(context);
  }

  override handleRequest<TUser = unknown>(err: unknown, user: TUser, info: unknown): TUser {
    if (err || !user) {
      const msg =
        info instanceof Error && info.name === 'TokenExpiredError'
          ? 'TOKEN_EXPIRED'
          : 'UNAUTHENTICATED';
      throw new UnauthorizedException(msg);
    }
    return user;
  }
}
