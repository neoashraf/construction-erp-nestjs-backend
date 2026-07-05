/**
 * aud-profile-avatar-cloudinary (#39) — /api/profile self-service + avatar, real Postgres.
 *
 * Covers:
 *   - FR-AUD-029/030: getProfile returns the caller's own view (identity + avatar + assignedProjects,
 *     NO permissions field); ALL scope for unscoped, assigned-list for scoped; deactivated → FORBIDDEN.
 *   - FR-AUD-032/034/037: updateProfile edits name/phone under optimistic version, no token churn.
 *   - FR-AUD-038/040/043: setAvatar persists url (public_id hidden), reflected in getProfile + /auth/me;
 *     replace sweeps the old asset; a storage failure → 503 and the row is unchanged.
 *   - FR-AUD-041: removeAvatar clears the columns and is idempotent when none set.
 *   - Guard smoke (skill §13): ProfileController carries real @UseGuards; the open GET route passes the
 *     RolesGuard for an authenticated user (no permission gate).
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ConflictException, ExecutionContext, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';
import { UserOrmEntity } from '../src/core/auth/infrastructure/user.orm-entity';
import { RefreshTokenOrmEntity } from '../src/core/auth/infrastructure/refresh-token.orm-entity';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateUser1700000700000 } from '../src/database/migrations/1700000700000-CreateUser';
import { CreateRbacAndAudit1700000800000 } from '../src/database/migrations/1700000800000-CreateRbacAndAudit';
import { RbacV2ResourcePermissions1700002300000 } from '../src/database/migrations/1700002300000-RbacV2ResourcePermissions';
import { AddUserAvatar1700002400000 } from '../src/database/migrations/1700002400000-AddUserAvatar';
import { TypeOrmUserRepository } from '../src/core/auth/infrastructure/typeorm-user.repository';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { ProfileQueryService } from '../src/core/auth/read/profile.query-service';
import { SessionQueryService } from '../src/core/auth/read/session.query-service';
import { ProfileUseCases, UploadedImage } from '../src/core/auth/application/profile.use-cases';
import { ProfileController } from '../src/core/auth/presentation/profile.controller';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { MediaStorage, MediaUploadInput, MediaUploadResult } from '../src/common/ports/driven-ports';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { NoopAuditService } from '../src/core/audit/infrastructure/noop-audit.service';
import { seedRolesPermissions } from '../src/database/seeds/seed-roles-permissions';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000cf001';
const FY = '00000000-0000-0000-0000-0000000cf0f1';
const ADMIN_USER = '00000000-0000-0000-0000-0000000cf0a1';
const PM_USER = '00000000-0000-0000-0000-0000000cf0a2';
const DEAD_USER = '00000000-0000-0000-0000-0000000cf0a3';
const PROJECT_A = '00000000-0000-0000-0000-0000000cf0d1';

class FakeMediaStorage implements MediaStorage {
  uploads: MediaUploadInput[] = [];
  deletes: string[] = [];
  failUpload = false;
  async upload(input: MediaUploadInput): Promise<MediaUploadResult> {
    if (this.failUpload) throw new ServiceUnavailableException('MEDIA_STORAGE_ERROR');
    this.uploads.push(input);
    return { url: `https://res.cloudinary.test/${input.publicId}.webp`, publicId: input.publicId! };
  }
  async delete(publicId: string): Promise<void> { this.deletes.push(publicId); }
}

function actorFor(userId: string, isUnscoped = false): Actor {
  return { userId, companyId: CO, financialYearId: FY, role: '', isUnscoped, assignedProjectIds: [], approvalLimit: null };
}
const img = (over?: Partial<UploadedImage>): UploadedImage => ({
  buffer: Buffer.from('pngbytes'), mimetype: 'image/png', size: 8, originalname: 'a.png', ...over,
});

describe('aud-profile-avatar-cloudinary (#39) — /api/profile + avatar (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let profiles: ProfileQueryService;
  let session: SessionQueryService;
  let useCases: ProfileUseCases;
  let media: FakeMediaStorage;

  const insertUser = async (id: string, email: string, role: string, active = true) => {
    await ds.query(
      `INSERT INTO "user" (id, company_id, financial_year_id, email, password_hash, name, role, is_active, must_change_password, version)
       VALUES ($1,$2,$3,$4,'x','Orig Name',$5,$6,false,1)`,
      [id, CO, FY, email, role, active],
    );
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    ds = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      synchronize: false,
      entities: [RoleOrmEntity, PermissionOrmEntity, UserOrmEntity, RefreshTokenOrmEntity],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
        CreateUser1700000700000,
        CreateRbacAndAudit1700000800000,
        RbacV2ResourcePermissions1700002300000,
        AddUserAvatar1700002400000,
      ],
    });
    await ds.initialize();
    await ds.runMigrations();

    await ds.query(`INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`, [CO]);
    await ds.query(`INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`, [FY, CO]);
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status)
       VALUES ($1,$2,'P-01','Meghna Bridge',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [PROJECT_A, CO, crypto.randomUUID(), PM_USER],
    );
    await seedRolesPermissions(ds, CO);

    await insertUser(ADMIN_USER, 'admin@ze.local', 'ADMIN');
    await insertUser(PM_USER, 'pm@ze.local', 'PROJECT_MANAGER');
    await insertUser(DEAD_USER, 'dead@ze.local', 'ADMIN', false);
    await ds.query(`INSERT INTO user_project (id, user_id, project_id, company_id) VALUES (gen_random_uuid(),$1,$2,$3)`, [PM_USER, PROJECT_A, CO]);

    profiles = new ProfileQueryService(ds);
    session = new SessionQueryService(ds);
    media = new FakeMediaStorage();
    const uow = new TypeOrmUnitOfWork(ds);
    useCases = new ProfileUseCases(new TypeOrmUserRepository(ds), media, new NoopAuditService(), uow, profiles);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  // ── FR-AUD-029/030: profile read ──
  describe('GET profile (FR-AUD-029/030)', () => {
    it('admin (unscoped): ALL scope, avatarUrl null, and NO permissions field', async () => {
      const v = await profiles.getProfile(actorFor(ADMIN_USER, true));
      expect(v.email).toBe('admin@ze.local');
      expect(v.assignedProjects).toEqual({ scope: 'ALL' });
      expect(v.avatarUrl).toBeNull();
      expect((v as any).permissions).toBeUndefined(); // permissions live on /auth/me, not here
      expect((v as any).avatar_public_id).toBeUndefined();
      expect(typeof v.version).toBe('number');
    });

    it('pm (scoped): assignedProjects lists the assigned project with its name', async () => {
      const v = await profiles.getProfile(actorFor(PM_USER));
      expect(v.assignedProjects).toEqual([{ projectId: PROJECT_A, projectName: 'Meghna Bridge' }]);
    });

    it('a deactivated caller → FORBIDDEN (FR-AUD-036)', async () => {
      await expect(profiles.getProfile(actorFor(DEAD_USER))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── FR-AUD-032/034/037: name/phone edit ──
  describe('PATCH profile (FR-AUD-032/034/037)', () => {
    it('updates name + phone and bumps version; getProfile reflects it', async () => {
      const before = await profiles.getProfile(actorFor(ADMIN_USER, true));
      const v = await useCases.updateProfile(actorFor(ADMIN_USER, true), { name: 'রফিক আহমেদ', phone: '+8801712345678', version: before.version });
      expect(v.name).toBe('রফিক আহমেদ');
      expect(v.phone).toBe('+8801712345678');
      expect(v.version).toBe(before.version + 1);
      const reread = await profiles.getProfile(actorFor(ADMIN_USER, true));
      expect(reread.name).toBe('রফিক আহমেদ');
    });

    it('a stale version → OPTIMISTIC_LOCK_CONFLICT', async () => {
      await expect(useCases.updateProfile(actorFor(ADMIN_USER, true), { name: 'X', version: 1 }))
        .rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── FR-AUD-038/040/043: avatar upload/replace ──
  describe('avatar upload / replace (FR-AUD-038/040/043)', () => {
    it('uploads and persists avatar_url; getProfile + /auth/me expose it, public_id stays hidden', async () => {
      const v = await useCases.setAvatar(actorFor(PM_USER), img());
      expect(v.avatarUrl).toBe(`https://res.cloudinary.test/user_${PM_USER}.webp`);

      const [row] = await ds.query(`SELECT avatar_url AS u, avatar_public_id AS p FROM "user" WHERE id=$1`, [PM_USER]);
      expect(row.u).toBe(`https://res.cloudinary.test/user_${PM_USER}.webp`);
      expect(row.p).toBe(`user_${PM_USER}`); // stored, but never projected

      const me = await session.me(actorFor(PM_USER));
      expect(me.user.avatarUrl).toBe(`https://res.cloudinary.test/user_${PM_USER}.webp`);
      const prof = await profiles.getProfile(actorFor(PM_USER));
      expect((prof as any).avatarPublicId).toBeUndefined();
      expect((prof as any).avatar_public_id).toBeUndefined();
    });

    it('a storage failure surfaces 503 and leaves the row unchanged', async () => {
      media.failUpload = true;
      const [beforeRow] = await ds.query(`SELECT avatar_url AS u FROM "user" WHERE id=$1`, [ADMIN_USER]);
      await expect(useCases.setAvatar(actorFor(ADMIN_USER, true), img())).rejects.toBeInstanceOf(ServiceUnavailableException);
      const [afterRow] = await ds.query(`SELECT avatar_url AS u FROM "user" WHERE id=$1`, [ADMIN_USER]);
      expect(afterRow.u).toBe(beforeRow.u); // untouched
      media.failUpload = false;
    });

    it('replacing with a different-id asset sweeps the previous one', async () => {
      // Seed a pre-existing avatar with a NON-deterministic public id.
      await ds.query(`UPDATE "user" SET avatar_url='https://old', avatar_public_id='legacy-id' WHERE id=$1`, [ADMIN_USER]);
      media.deletes = [];
      await useCases.setAvatar(actorFor(ADMIN_USER, true), img());
      expect(media.deletes).toContain('legacy-id');
    });
  });

  // ── FR-AUD-041: remove ──
  describe('DELETE avatar (FR-AUD-041)', () => {
    it('clears the columns and is idempotent when none set', async () => {
      // PM currently has an avatar (set above) → remove clears it.
      const removed = await useCases.removeAvatar(actorFor(PM_USER));
      expect(removed.avatarUrl).toBeNull();
      const [row] = await ds.query(`SELECT avatar_url AS u, avatar_public_id AS p FROM "user" WHERE id=$1`, [PM_USER]);
      expect(row.u).toBeNull();
      expect(row.p).toBeNull();

      // Second remove → idempotent no-op, no storage call.
      media.deletes = [];
      const again = await useCases.removeAvatar(actorFor(PM_USER));
      expect(again.avatarUrl).toBeNull();
      expect(media.deletes).toHaveLength(0);
    });
  });

  // ── Guard smoke (skill §13) ──
  describe('guard smoke — ProfileController carries real guards', () => {
    it('the controller class declares @UseGuards (JwtAuthGuard + RolesGuard)', () => {
      const guards = Reflect.getMetadata('__guards__', ProfileController) ?? [];
      expect(guards.length).toBe(2);
      expect(guards.map((g: any) => g.name)).toEqual(expect.arrayContaining(['JwtAuthGuard', 'RolesGuard']));
    });

    it('the open GET route passes RolesGuard for an authenticated user (no permission gate)', async () => {
      const guard = new RolesGuard(new Reflector(), new TypeOrmRoleRepository(ds), new TypeOrmPermissionRepository(ds));
      const ctx = {
        getHandler: () => ProfileController.prototype.getProfile,
        getClass: () => ProfileController,
        switchToHttp: () => ({ getRequest: () => ({ user: actorFor(ADMIN_USER, true) }) }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });
});
