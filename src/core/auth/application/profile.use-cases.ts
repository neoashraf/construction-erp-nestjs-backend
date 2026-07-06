/**
 * Profile self-service use cases (AUD application — FR-AUD-032/033/034/037/038..043). The caller edits
 * ONLY their own name/phone and manages their own avatar; nothing authorization-bearing is touched and
 * no tokens are revoked. Each mutation runs in a UnitOfWork with an audit row; the avatar binary is
 * offloaded to the MediaStorage port (Cloudinary), the User row keeps only url + public_id.
 *
 * PURE application layer (only @Injectable). Self-scoped: the target is always the token's userId.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  ConflictException,
} from '@nestjs/common';
import { UnitOfWork, UNIT_OF_WORK } from '../../../common/ports/unit-of-work.port';
import { MediaStorage, MEDIA_STORAGE } from '../../../common/ports/driven-ports';
import { UserRepository, USER_REPOSITORY } from '../domain/ports/user.repository.port';
import { AUDIT_SERVICE, AuditService } from '../../audit/application/audit.port';
import { Actor } from '../../tenancy/tenant-context';
import { ProfileQueryService } from '../read/profile.query-service';
import { ProfileView } from '../read/dto/profile-view.dto';

/** The uploaded image as populated by Multer memory storage (no @types/multer dependency). */
export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB (FR-AUD-039)
const E164 = /^\+[1-9]\d{6,14}$/;

@Injectable()
export class ProfileUseCases {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(MEDIA_STORAGE) private readonly media: MediaStorage,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly profiles: ProfileQueryService,
  ) {}

  /** PATCH /api/profile — self-edit name and/or phone, optimistic-locked, audited (FR-AUD-032/033/034/037). */
  async updateProfile(
    actor: Actor,
    dto: { name?: string; phone?: string | null; version: number },
  ): Promise<ProfileView> {
    if (dto.name === undefined && dto.phone === undefined) {
      throw new BadRequestException('VALIDATION_ERROR'); // empty edit (FR-AUD-034)
    }
    if (dto.phone !== undefined && dto.phone !== null && !E164.test(dto.phone)) {
      throw new BadRequestException('VALIDATION_ERROR'); // non-E.164 phone
    }

    await this.uow.run(async () => {
      const user = await this.loadSelf(actor);
      if (user.props.version !== dto.version) {
        throw new ConflictException('OPTIMISTIC_LOCK_CONFLICT');
      }
      let before: Record<string, unknown>;
      let after: Record<string, unknown>;
      try {
        ({ before, after } = user.editProfile({ name: dto.name, phone: dto.phone }));
      } catch {
        throw new BadRequestException('VALIDATION_ERROR'); // empty name
      }
      await this.users.save(user);
      await this.audit.record({
        action: 'UPDATE', entityType: 'User', entityId: actor.userId,
        actorId: actor.userId, companyId: actor.companyId, before, after,
      });
    });
    return this.profiles.getProfile(actor); // refreshed view, post-commit
  }

  /** POST /api/profile/image — upload/replace the avatar via MediaStorage, audited (FR-AUD-038/039/040/042/043). */
  async setAvatar(actor: Actor, file: UploadedImage | undefined): Promise<ProfileView> {
    this.assertValidImage(file);

    // Upload BEFORE the DB transaction: a storage failure (503) leaves the User row untouched.
    const uploaded = await this.media.upload({
      buffer: file!.buffer,
      mimeType: file!.mimetype,
      folder: `companies/${actor.companyId}/avatars`,
      publicId: `user_${actor.userId}`,
    });

    let oldPublicId: string | null = null;
    await this.uow.run(async () => {
      const user = await this.loadSelf(actor);
      oldPublicId = user.props.avatarPublicId;
      const before = { avatarUrl: user.props.avatarUrl };
      user.setAvatar(uploaded.url, uploaded.publicId);
      await this.users.save(user);
      await this.audit.record({
        action: 'UPDATE', entityType: 'User', entityId: actor.userId,
        actorId: actor.userId, companyId: actor.companyId,
        before, after: { avatarUrl: uploaded.url },
      });
    });

    // Replace: sweep the previous asset if it was a different one. Non-fatal — the new avatar is live (FR-AUD-040).
    if (oldPublicId && oldPublicId !== uploaded.publicId) {
      try {
        await this.media.delete(oldPublicId);
      } catch {
        /* best-effort: a stale asset is swept, never surfaced to the user */
      }
    }
    return this.profiles.getProfile(actor);
  }

  /** DELETE /api/profile/image — remove the avatar; idempotent when none set (FR-AUD-041/042/043). */
  async removeAvatar(actor: Actor): Promise<ProfileView> {
    const user = await this.loadSelf(actor);
    const publicId = user.props.avatarPublicId;
    if (!publicId) {
      return this.profiles.getProfile(actor); // idempotent no-op — no storage call, no write
    }

    // Delete the asset first: a storage failure (503) leaves the User row untouched (FR-AUD-041).
    await this.media.delete(publicId);

    await this.uow.run(async () => {
      const fresh = await this.loadSelf(actor);
      const before = { avatarUrl: fresh.props.avatarUrl };
      fresh.clearAvatar();
      await this.users.save(fresh);
      await this.audit.record({
        action: 'UPDATE', entityType: 'User', entityId: actor.userId,
        actorId: actor.userId, companyId: actor.companyId,
        before, after: { avatarUrl: null },
      });
    });
    return this.profiles.getProfile(actor);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async loadSelf(actor: Actor) {
    const user = await this.users.findById(actor.userId);
    // Self-scoped + per-request activation re-check (FR-AUD-009/036); deactivated/foreign → FORBIDDEN.
    if (!user || user.props.companyId !== actor.companyId || !user.props.isActive) {
      throw new ForbiddenException('FORBIDDEN');
    }
    return user;
  }

  private assertValidImage(file: UploadedImage | undefined): void {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('VALIDATION_ERROR'); // no file part / empty file
    }
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException('UNSUPPORTED_MEDIA_TYPE');
    }
    if (file.size > MAX_BYTES || file.buffer.length > MAX_BYTES) {
      throw new PayloadTooLargeException('PAYLOAD_TOO_LARGE');
    }
  }
}
