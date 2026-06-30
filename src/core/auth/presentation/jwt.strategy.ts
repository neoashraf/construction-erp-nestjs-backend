/**
 * JwtStrategy (PRESENTATION) — passport-jwt, validates signature + expiry, re-loads user,
 * asserts is_active (FR-AUD-009). Sets request.user = Actor for @CurrentActor() / @CurrentUser().
 */
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from '../application/auth.service';
import { Actor } from '../../tenancy/tenant-context';

interface JwtPayload {
  sub: string;
  companyId: string;
  financialYearId: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /** Called after signature + expiry validation; re-checks is_active (FR-AUD-009). */
  async validate(payload: JwtPayload): Promise<Actor> {
    const user = await this.auth.validateUserById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User is inactive or not found');
    }
    return {
      userId: user.id,
      companyId: user.props.companyId,
      financialYearId: user.props.financialYearId,
      role: user.props.role,
    };
  }
}
