/**
 * aud-session-and-forced-change (#38) — GET /api/auth/me session projection + forced-change gate, real Postgres.
 *
 * Covers:
 *   - FR-AUD-031: me() returns the caller's own SessionView (user/projectScope/approvalLimit/permissions),
 *     never password_hash; scope resolution (ALL for unscoped, ASSIGNED for scoped incl. zero-assignment).
 *   - FR-AUD-033: live projection — an Admin grant on the role reflects on the caller's next me() (no cache).
 *   - FR-AUD-030: reset re-arms must_change_password; change-password clears it; me() surfaces the flag;
 *     PasswordChangePolicyGuard 403s a must-change user everywhere except the allow-list (end-to-end with a real token).
 *   - FR-AUD-027: company-scoped; deactivated caller → FORBIDDEN.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
import { DbRefreshTokenStore } from '../src/core/auth/infrastructure/db-refresh-token-store';
import { BcryptPasswordHasher } from '../src/core/auth/infrastructure/bcrypt-password-hasher';
import { JwtTokenSigner } from '../src/core/auth/infrastructure/jwt-token-signer';
import { AuthService } from '../src/core/auth/application/auth.service';
import { SessionQueryService } from '../src/core/auth/read/session.query-service';
import { PermissionUseCases, UserAdminUseCases } from '../src/core/auth/application/rbac.use-cases';
import { PasswordChangePolicyGuard } from '../src/core/auth/presentation/password-change-policy.guard';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { NoopAuditService } from '../src/core/audit/infrastructure/noop-audit.service';
import { seedRolesPermissions } from '../src/database/seeds/seed-roles-permissions';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-secret-32-chars-min-padding!!';
const CO = '00000000-0000-0000-0000-0000000ce801';
const FY = '00000000-0000-0000-0000-0000000ce8f1';
const ADMIN_USER = '00000000-0000-0000-0000-0000000ce8a1';
const PM_USER = '00000000-0000-0000-0000-0000000ce8a2';
const PM_ZERO_USER = '00000000-0000-0000-0000-0000000ce8a3';
const GATE_USER = '00000000-0000-0000-0000-0000000ce8a4';
const SITE_ENGINEER_USER = '00000000-0000-0000-0000-0000000ce8a5';
const HR_MANAGER_USER = '00000000-0000-0000-0000-0000000ce8a6';
const PROJECT_A = '00000000-0000-0000-0000-0000000ce8d1';

function configService() {
  const cfg: Record<string, string> = { JWT_SECRET, JWT_ACCESS_TTL: '900s', JWT_REFRESH_TTL: '7d' };
  return { getOrThrow: (k: string) => cfg[k], get: (k: string, d?: string) => cfg[k] ?? d } as any;
}

function actorFor(userId: string): Actor {
  return { userId, companyId: CO, financialYearId: FY, role: '', isUnscoped: false, assignedProjectIds: [], approvalLimit: null };
}

describe('aud-session-and-forced-change (#38) — /auth/me + forced-change gate (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let session: SessionQueryService;
  let permissionUseCases: PermissionUseCases;
  let userAdmin: UserAdminUseCases;
  let auth: AuthService;
  let signer: JwtTokenSigner;
  let guard: PasswordChangePolicyGuard;

  const insertUser = async (id: string, email: string, role: string, mustChange = false) => {
    await ds.query(
      `INSERT INTO "user" (id, company_id, financial_year_id, email, password_hash, name, role, is_active, must_change_password, version)
       VALUES ($1,$2,$3,$4,'x','U',$5,true,$6,1)`,
      [id, CO, FY, email, role, mustChange],
    );
  };

  function ctx(method: string, path: string, authHeader?: string): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ method, path, headers: authHeader ? { authorization: authHeader } : {} }) }),
    } as unknown as ExecutionContext;
  }

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
       VALUES ($1,$2,'P-01','Site A',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [PROJECT_A, CO, crypto.randomUUID(), PM_USER],
    );
    await seedRolesPermissions(ds, CO);

    await insertUser(ADMIN_USER, 'admin@ze.local', 'ADMIN');
    await insertUser(PM_USER, 'pm@ze.local', 'PROJECT_MANAGER');
    await insertUser(PM_ZERO_USER, 'pmzero@ze.local', 'PROJECT_MANAGER');
    await insertUser(GATE_USER, 'gate@ze.local', 'ADMIN');
    await insertUser(SITE_ENGINEER_USER, 'site-engineer@ze.local', 'SITE_ENGINEER');
    await insertUser(HR_MANAGER_USER, 'hr-manager@ze.local', 'HR_MANAGER');
    await ds.query(`INSERT INTO user_project (id, user_id, project_id, company_id) VALUES (gen_random_uuid(),$1,$2,$3)`, [PM_USER, PROJECT_A, CO]);

    session = new SessionQueryService(ds);
    const uow = new TypeOrmUnitOfWork(ds);
    const audit = new NoopAuditService();
    const hasher = new BcryptPasswordHasher();
    const store = new DbRefreshTokenStore(ds);
    signer = new JwtTokenSigner(new JwtService({}), configService());
    const userRepo = new TypeOrmUserRepository(ds);
    const roleRepo = new (await import('../src/core/auth/infrastructure/typeorm-role.repository')).TypeOrmRoleRepository(ds);
    const permRepo = new (await import('../src/core/auth/infrastructure/typeorm-permission.repository')).TypeOrmPermissionRepository(ds);
    permissionUseCases = new PermissionUseCases(roleRepo, permRepo, audit, uow);
    userAdmin = new UserAdminUseCases(userRepo, roleRepo, hasher, store, audit, uow);
    auth = new AuthService(userRepo, hasher, signer, store);
    guard = new PasswordChangePolicyGuard(signer, auth);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  // ── FR-AUD-031: session projection ──
  describe('FR-AUD-031 — session projection', () => {
    it('me(admin): user shape (no password_hash), ALL scope, non-empty resource-level permissions', async () => {
      const view = await session.me(actorFor(ADMIN_USER));
      expect(view.user.email).toBe('admin@ze.local');
      expect((view.user as any).passwordHash).toBeUndefined();
      expect((view.user as any).password_hash).toBeUndefined();
      expect(view.projectScope).toEqual({ scope: 'ALL' });
      expect(view.permissions.length).toBeGreaterThan(10);
      expect(view.permissions[0]).toHaveProperty('resource');
      expect(view.permissions[0]).toHaveProperty('action');
      expect(view.user.mustChangePassword).toBe(false);
    });

    it('me(pm): ASSIGNED scope with the assigned projectIds', async () => {
      const view = await session.me(actorFor(PM_USER));
      expect(view.projectScope).toEqual({ scope: 'ASSIGNED', projectIds: [PROJECT_A] });
    });

    it('me(pm with zero assignments): ASSIGNED scope, empty projectIds (edge case 19)', async () => {
      const view = await session.me(actorFor(PM_ZERO_USER));
      expect(view.projectScope).toEqual({ scope: 'ASSIGNED', projectIds: [] });
    });

    it('a deactivated caller → FORBIDDEN (FR-AUD-009/027)', async () => {
      await ds.query(`UPDATE "user" SET is_active=false WHERE id=$1`, [PM_ZERO_USER]);
      await expect(session.me(actorFor(PM_ZERO_USER))).rejects.toBeInstanceOf(ForbiddenException);
      await ds.query(`UPDATE "user" SET is_active=true WHERE id=$1`, [PM_ZERO_USER]);
    });

    // aud-holidays-resource — the split must show up in the caller's own live session projection,
    // not just at the guard (FR-AUD-013/033).
    it('me(site engineer): permissions contain hr.attendance:READ/CREATE but no hr.holidays grant', async () => {
      const view = await session.me(actorFor(SITE_ENGINEER_USER));
      expect(view.permissions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resource: 'hr.attendance', action: 'READ' }),
          expect.objectContaining({ resource: 'hr.attendance', action: 'CREATE' }),
        ]),
      );
      expect(view.permissions.some(p => p.resource === 'hr.holidays')).toBe(false);
    });

    it('me(hr manager): permissions contain hr.holidays with all four actions', async () => {
      const view = await session.me(actorFor(HR_MANAGER_USER));
      const holidayActions = view.permissions.filter(p => p.resource === 'hr.holidays').map(p => p.action).sort();
      expect(holidayActions).toEqual(['CREATE', 'DELETE', 'READ', 'UPDATE']);
    });
  });

  // ── FR-AUD-033: live projection ──
  it('FR-AUD-033 — an Admin grant on the role reflects on the caller next me() (no re-login)', async () => {
    const before = await session.me(actorFor(PM_USER));
    expect(before.permissions.some(p => p.resource === 'audit.audit_log')).toBe(false);

    const [pmRole] = await ds.query(`SELECT id FROM "role" WHERE company_id=$1 AND name='PROJECT_MANAGER'`, [CO]);
    await permissionUseCases.createPermission(actorFor(ADMIN_USER), {
      roleId: pmRole.id, resource: 'audit.audit_log', action: 'READ', projectScope: 'ASSIGNED',
    });

    const after = await session.me(actorFor(PM_USER));
    expect(after.permissions.some(p => p.resource === 'audit.audit_log' && p.action === 'READ')).toBe(true);
  });

  // ── FR-AUD-030: forced-change flag set/clear + surfaced by me() ──
  it('FR-AUD-030 — reset re-arms must_change_password; change-password clears it; me() surfaces it', async () => {
    await userAdmin.resetPassword(GATE_USER, actorFor(ADMIN_USER), { temporaryPassword: 'TempPass99!' });
    let [row] = await ds.query(`SELECT must_change_password AS m FROM "user" WHERE id=$1`, [GATE_USER]);
    expect(row.m).toBe(true);
    expect((await session.me(actorFor(GATE_USER))).user.mustChangePassword).toBe(true);

    await auth.changePassword(GATE_USER, 'TempPass99!', 'BrandNewPass99!');
    [row] = await ds.query(`SELECT must_change_password AS m FROM "user" WHERE id=$1`, [GATE_USER]);
    expect(row.m).toBe(false);
    expect((await session.me(actorFor(GATE_USER))).user.mustChangePassword).toBe(false);
  });

  // ── FR-AUD-030: the gate end-to-end (real token through PasswordChangePolicyGuard) ──
  it('FR-AUD-030 — gate: must-change user is 403 everywhere except the allow-list; cleared → access resumes', async () => {
    // Re-arm the flag on GATE_USER and mint a real access token for them.
    await userAdmin.resetPassword(GATE_USER, actorFor(ADMIN_USER), { temporaryPassword: 'TempPass99!' });
    const token = signer.signAccess({ sub: GATE_USER, companyId: CO, financialYearId: FY, role: 'ADMIN' });
    const bearer = `Bearer ${token}`;

    // Blocked on a normal route ...
    await expect(guard.canActivate(ctx('GET', '/api/users', bearer))).rejects.toMatchObject({ message: 'PASSWORD_CHANGE_REQUIRED' });
    // ... but the four recovery routes are allowed.
    await expect(guard.canActivate(ctx('GET', '/api/auth/me', bearer))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('POST', '/api/auth/change-password', bearer))).resolves.toBe(true);

    // Change the password → flag cleared → normal access resumes with the SAME token (flag read live, not from token).
    await auth.changePassword(GATE_USER, 'TempPass99!', 'AnotherNewPass99!');
    await expect(guard.canActivate(ctx('GET', '/api/users', bearer))).resolves.toBe(true);
  });
});
