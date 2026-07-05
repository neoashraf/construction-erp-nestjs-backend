/**
 * ProfileController (PRESENTATION) — `/api/profile`. Self-service account surface (AUD profile slice,
 * FR-AUD-029..043). Every route is self-scoped to the token's user (no `:id`) and open to any
 * authenticated, active user — no role/permission gate (RolesGuard passes routes with no
 * @RequirePermission). Guards are still present as defence-in-depth + the forced-change gate.
 *
 *   GET    /api/profile         — the caller's own profile (identity + avatar + assigned projects)
 *   PATCH  /api/profile         — edit name/phone only (optimistic version, audited, no token churn)
 *   POST   /api/profile/image   — upload/replace the avatar (multipart 'image' → Cloudinary)
 *   DELETE /api/profile/image   — remove the avatar
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { CurrentActor } from './current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { ProfileQueryService } from '../read/profile.query-service';
import { ProfileUseCases, UploadedImage } from '../application/profile.use-cases';

class UpdateProfileDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  /** string to set, null to clear; E.164 shape re-checked in the use case (FR-AUD-034). */
  @IsOptional() @ValidateIf((o: UpdateProfileDto) => o.phone !== null) @IsString() phone?: string | null;
  @IsInt() version!: number;
}

// Defensive upper bound so a pathological upload can't exhaust memory; the precise 5 MB rule
// (→ 413 PAYLOAD_TOO_LARGE) is enforced in the use case (FR-AUD-039).
const MULTER_HARD_LIMIT = 20 * 1024 * 1024;

@ApiTags('Profile')
@ApiBearerAuth('access-token')
@Controller('api/profile')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProfileController {
  constructor(
    private readonly profiles: ProfileQueryService,
    private readonly useCases: ProfileUseCases,
  ) {}

  @Get()
  getProfile(@CurrentActor() actor: Actor) {
    return this.profiles.getProfile(actor);
  }

  @Patch()
  update(@Body() dto: UpdateProfileDto, @CurrentActor() actor: Actor) {
    return this.useCases.updateProfile(actor, dto);
  }

  @Post('image')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MULTER_HARD_LIMIT } }))
  uploadImage(@UploadedFile() file: UploadedImage | undefined, @CurrentActor() actor: Actor) {
    return this.useCases.setAvatar(actor, file);
  }

  @Delete('image')
  removeImage(@CurrentActor() actor: Actor) {
    return this.useCases.removeAvatar(actor);
  }
}
