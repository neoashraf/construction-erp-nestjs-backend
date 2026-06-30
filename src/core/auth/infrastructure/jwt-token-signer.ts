/** JwtTokenSigner (INFRASTRUCTURE) — signs/verifies access + refresh tokens via @nestjs/jwt. */
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenSigner, AccessClaims, RefreshClaims } from '../domain/ports/token-signer.port';

@Injectable()
export class JwtTokenSigner implements TokenSigner {
  private readonly secret: string;
  private readonly accessTtl: string;
  private readonly refreshTtl: string;

  constructor(private readonly jwt: JwtService, config: ConfigService) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
    this.accessTtl = config.get<string>('JWT_ACCESS_TTL', '900s');
    this.refreshTtl = config.get<string>('JWT_REFRESH_TTL', '7d');
  }

  signAccess(claims: AccessClaims): string {
    return this.jwt.sign(
      { sub: claims.sub, companyId: claims.companyId, financialYearId: claims.financialYearId, role: claims.role },
      { secret: this.secret, expiresIn: this.accessTtl as any },
    );
  }

  signRefresh(claims: RefreshClaims): string {
    return this.jwt.sign(
      { sub: claims.sub, jti: claims.jti, companyId: claims.companyId },
      { secret: this.secret, expiresIn: this.refreshTtl as any },
    );
  }

  verifyAccess(token: string): AccessClaims {
    const p = this.jwt.verify<Record<string, unknown>>(token, { secret: this.secret });
    return { sub: p['sub'] as string, companyId: p['companyId'] as string, financialYearId: p['financialYearId'] as string, role: p['role'] as AccessClaims['role'] };
  }

  verifyRefresh(token: string): RefreshClaims {
    const p = this.jwt.verify<Record<string, unknown>>(token, { secret: this.secret });
    return { sub: p['sub'] as string, jti: p['jti'] as string, companyId: p['companyId'] as string };
  }
}
