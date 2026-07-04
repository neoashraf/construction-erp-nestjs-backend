/**
 * AuthController (PRESENTATION) — `/api/auth` (FR-AUD-001/004/005/006/008/009).
 * Public: login. Authenticated (JWT bearer): refresh (refresh token only), logout, change-password.
 *
 * Login companyId: Phase 1 is single-company; the caller supplies x-company-id header OR the
 * optional companyId body field. The guard seam in @CurrentActor / the JWT strategy handles
 * multi-company once auth is wired. For the contract endpoint shape see api-contracts/05.
 */
import { Body, Controller, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { AuthService } from '../application/auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentActor } from './current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { SessionQueryService } from '../read/session.query-service';

class LoginDto {
  @IsEmail()
  email!: string;
  @IsString()
  password!: string;
  /** Optional in Phase 1 (single-company UI); falls back to x-company-id header. */
  @IsOptional()
  @IsUUID()
  companyId?: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

class LogoutDto {
  @IsString()
  refreshToken!: string;
}

class ChangePasswordDto {
  @IsString()
  currentPassword!: string;
  @IsString()
  @MinLength(10)
  newPassword!: string;
}

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly session: SessionQueryService,
  ) {}

  /**
   * GET /api/auth/me — FR-AUD-031/032/033. Authenticated (any role); returns the caller's OWN live
   * session projection. Allow-listed on the forced-change gate so a must_change_password user can still
   * discover the flag and route to change-password.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentActor() actor: Actor) {
    return this.session.me(actor);
  }

  /** POST /api/auth/login — FR-AUD-001/008/009. Public, no JWT required. */
  @Post('login')
  @HttpCode(200)
  login(
    @Body() dto: LoginDto,
    @Headers('x-company-id') companyHeader?: string,
  ) {
    const companyId = dto.companyId ?? companyHeader ?? '';
    return this.auth.login(companyId, dto.email, dto.password);
  }

  /** POST /api/auth/refresh — FR-AUD-004. Refresh token in body; no access token needed. */
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /** POST /api/auth/logout — FR-AUD-005. Access token required; revokes refresh token. */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async logout(@Body() dto: LogoutDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  /** POST /api/auth/change-password — FR-AUD-006. Access token required. */
  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    await this.auth.changePassword(actor.userId, dto.currentPassword, dto.newPassword);
  }
}
