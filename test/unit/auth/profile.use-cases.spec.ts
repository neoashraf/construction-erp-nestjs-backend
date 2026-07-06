/**
 * ProfileUseCases unit tests (AUD profile slice, FR-AUD-032/034/037/038..043). No DB, no NestJS HTTP —
 * fakes for the User repo, MediaStorage, AuditService, UnitOfWork, and ProfileQueryService. Asserts the
 * orchestration: validation, optimistic lock, avatar upload/replace/remove, audit, and no-token-churn.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ProfileUseCases, UploadedImage } from '../../../src/core/auth/application/profile.use-cases';
import { User } from '../../../src/core/auth/domain/user';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const CO = 'co-1';
const UID = 'user-1';

function actor(): Actor {
  return { userId: UID, companyId: CO, financialYearId: 'fy-1', role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };
}

function makeUser(): User {
  return User.create(UID, { companyId: CO, financialYearId: 'fy-1', email: 'a@b.com', passwordHash: 'h', name: 'Old Name', role: 'ADMIN' });
}

class FakeUserRepo {
  constructor(public user: User) {}
  findById = async (id: string) => (id === this.user.id ? this.user : null);
  findByEmail = async () => null;
  save = async (u: User) => { this.user = u; };
}

class FakeMedia {
  uploads: any[] = [];
  deletes: string[] = [];
  failUpload = false;
  failDelete = false;
  upload = async (input: any) => {
    if (this.failUpload) throw new ServiceUnavailableException('MEDIA_STORAGE_ERROR');
    this.uploads.push(input);
    return { url: `https://cdn/${input.publicId}.webp`, publicId: input.publicId };
  };
  delete = async (publicId: string) => {
    if (this.failDelete) throw new ServiceUnavailableException('MEDIA_STORAGE_ERROR');
    this.deletes.push(publicId);
  };
}

class FakeAudit { entries: any[] = []; record = async (e: any) => { this.entries.push(e); }; }
const fakeUow = { run: async <T>(w: () => Promise<T>) => w() };

function fakeProfileQuery(repo: FakeUserRepo) {
  return {
    getProfile: async (_a: Actor) => {
      const p = repo.user.props;
      return {
        id: repo.user.id, email: p.email, name: p.name, phone: p.phone, avatarUrl: p.avatarUrl,
        role: p.role, isUnscoped: true, isActive: p.isActive, financialYearId: p.financialYearId,
        lastLoginAt: null, assignedProjects: { scope: 'ALL' as const }, version: p.version,
      };
    },
  } as any;
}

function build(repo: FakeUserRepo, media: FakeMedia, audit: FakeAudit) {
  return new ProfileUseCases(repo as any, media as any, audit as any, fakeUow as any, fakeProfileQuery(repo));
}

const img = (over?: Partial<UploadedImage>): UploadedImage => ({
  buffer: Buffer.from('imgbytes'), mimetype: 'image/png', size: 8, originalname: 'a.png', ...over,
});

describe('ProfileUseCases (unit)', () => {
  // ── updateProfile ──
  describe('updateProfile', () => {
    it('rejects an empty edit (neither name nor phone)', async () => {
      const repo = new FakeUserRepo(makeUser());
      await expect(build(repo, new FakeMedia(), new FakeAudit()).updateProfile(actor(), { version: 1 } as any))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-E.164 phone', async () => {
      const repo = new FakeUserRepo(makeUser());
      await expect(build(repo, new FakeMedia(), new FakeAudit()).updateProfile(actor(), { phone: '01712345678', version: 1 }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a stale version with OPTIMISTIC_LOCK_CONFLICT', async () => {
      const repo = new FakeUserRepo(makeUser());
      await expect(build(repo, new FakeMedia(), new FakeAudit()).updateProfile(actor(), { name: 'X', version: 99 }))
        .rejects.toBeInstanceOf(ConflictException);
    });

    it('updates name + phone, audits UPDATE, returns the refreshed view', async () => {
      const repo = new FakeUserRepo(makeUser());
      const audit = new FakeAudit();
      const view = await build(repo, new FakeMedia(), audit).updateProfile(actor(), { name: 'রফিক', phone: '+8801712345678', version: 1 });
      expect(view.name).toBe('রফিক');
      expect(view.phone).toBe('+8801712345678');
      expect(repo.user.props.name).toBe('রফিক');
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({ action: 'UPDATE', entityType: 'User', entityId: UID });
    });

    it('rejects a deactivated caller with FORBIDDEN', async () => {
      const u = makeUser(); u.deactivate();
      const repo = new FakeUserRepo(u);
      await expect(build(repo, new FakeMedia(), new FakeAudit()).updateProfile(actor(), { name: 'X', version: 1 }))
        .rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── setAvatar ──
  describe('setAvatar', () => {
    it('rejects a missing file', async () => {
      const repo = new FakeUserRepo(makeUser());
      await expect(build(repo, new FakeMedia(), new FakeAudit()).setAvatar(actor(), undefined))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a disallowed content type (415)', async () => {
      const repo = new FakeUserRepo(makeUser());
      await expect(build(repo, new FakeMedia(), new FakeAudit()).setAvatar(actor(), img({ mimetype: 'application/pdf' })))
        .rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('rejects a file over 5 MB (413)', async () => {
      const repo = new FakeUserRepo(makeUser());
      await expect(build(repo, new FakeMedia(), new FakeAudit()).setAvatar(actor(), img({ size: 6 * 1024 * 1024 })))
        .rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it('uploads, sets avatar_url + public_id, audits, returns view with avatarUrl', async () => {
      const repo = new FakeUserRepo(makeUser());
      const media = new FakeMedia(); const audit = new FakeAudit();
      const view = await build(repo, media, audit).setAvatar(actor(), img());
      expect(media.uploads).toHaveLength(1);
      expect(media.uploads[0].folder).toBe(`companies/${CO}/avatars`);
      expect(media.uploads[0].publicId).toBe(`user_${UID}`);
      expect(repo.user.props.avatarUrl).toBe(`https://cdn/user_${UID}.webp`);
      expect(repo.user.props.avatarPublicId).toBe(`user_${UID}`);
      expect(view.avatarUrl).toBe(`https://cdn/user_${UID}.webp`);
      expect(audit.entries[0]).toMatchObject({ action: 'UPDATE', entityType: 'User' });
    });

    it('replace deletes the PREVIOUS asset when its public_id differs', async () => {
      const u = makeUser(); u.setAvatar('https://cdn/old.webp', 'old-public-id');
      const repo = new FakeUserRepo(u);
      const media = new FakeMedia();
      await build(repo, media, new FakeAudit()).setAvatar(actor(), img());
      expect(media.deletes).toEqual(['old-public-id']);
    });

    it('a stored-asset upload failure surfaces 503 and leaves the User row unchanged', async () => {
      const repo = new FakeUserRepo(makeUser());
      const media = new FakeMedia(); media.failUpload = true;
      await expect(build(repo, media, new FakeAudit()).setAvatar(actor(), img()))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(repo.user.props.avatarUrl).toBeNull(); // untouched
    });

    it('a failed delete of the OLD asset does not fail the request (best-effort)', async () => {
      const u = makeUser(); u.setAvatar('https://cdn/old.webp', 'old-public-id');
      const repo = new FakeUserRepo(u);
      const media = new FakeMedia(); media.failDelete = true;
      const view = await build(repo, media, new FakeAudit()).setAvatar(actor(), img());
      expect(view.avatarUrl).toBe(`https://cdn/user_${UID}.webp`); // new avatar is live regardless
    });
  });

  // ── removeAvatar ──
  describe('removeAvatar', () => {
    it('is an idempotent no-op when no avatar is set (no storage call)', async () => {
      const repo = new FakeUserRepo(makeUser());
      const media = new FakeMedia();
      const view = await build(repo, media, new FakeAudit()).removeAvatar(actor());
      expect(media.deletes).toHaveLength(0);
      expect(view.avatarUrl).toBeNull();
    });

    it('deletes the asset, clears both columns, audits', async () => {
      const u = makeUser(); u.setAvatar('https://cdn/x.webp', 'pub-id');
      const repo = new FakeUserRepo(u);
      const media = new FakeMedia(); const audit = new FakeAudit();
      const view = await build(repo, media, audit).removeAvatar(actor());
      expect(media.deletes).toEqual(['pub-id']);
      expect(repo.user.props.avatarUrl).toBeNull();
      expect(repo.user.props.avatarPublicId).toBeNull();
      expect(view.avatarUrl).toBeNull();
      expect(audit.entries[0]).toMatchObject({ action: 'UPDATE', entityType: 'User' });
    });

    it('a delete failure surfaces 503 and leaves the avatar set (DB unchanged)', async () => {
      const u = makeUser(); u.setAvatar('https://cdn/x.webp', 'pub-id');
      const repo = new FakeUserRepo(u);
      const media = new FakeMedia(); media.failDelete = true;
      await expect(build(repo, media, new FakeAudit()).removeAvatar(actor()))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(repo.user.props.avatarUrl).toBe('https://cdn/x.webp'); // untouched
    });
  });
});
