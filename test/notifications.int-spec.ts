/**
 * ntf-foundation (#40) — notification store + emit + REST feed + WebSocket gateway, real Postgres.
 *
 * Covers: recipient resolution (ROLE/PROJECT_ROLE/USER + deactivated-exclude, FR-NTF-017/018/020);
 * emit fan-out + idempotency (FR-NTF-002/019); the REST feed (list/filters/unread-count/getForRecipient
 * + mark-read/read-all, FR-NTF-004/005/013/014/015); best-effort push (fake pusher, FR-NTF-010);
 * the WebSocket handshake (JWT → room / bad token → reject, FR-NTF-008/009); + the §13 guard smoke.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
import { CreateNotification1700002500000 } from '../src/database/migrations/1700002500000-CreateNotification';
import { SqlRecipientResolver } from '../src/core/notifications/infrastructure/sql-recipient-resolver';
import { TypeOrmNotificationRepository } from '../src/core/notifications/infrastructure/typeorm-notification.repository';
import { NotificationService } from '../src/core/notifications/application/notification.service';
import { NotificationsQueryService } from '../src/core/notifications/read/notifications.query-service';
import { NotificationsController } from '../src/core/notifications/presentation/notifications.controller';
import { NotificationsGateway, roomFor } from '../src/core/notifications/presentation/notifications.gateway';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { JwtTokenSigner } from '../src/core/auth/infrastructure/jwt-token-signer';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { NotificationPusher } from '../src/core/notifications/domain/ports/notification-pusher.port';
import { NotificationView } from '../src/core/notifications/read/dto/notification-view.dto';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-secret-32-chars-min-padding!!';
const CO = '00000000-0000-0000-0000-0000000cff01';
const FY = '00000000-0000-0000-0000-0000000cfff1';
const AM1 = '00000000-0000-0000-0000-0000000cffa1';
const AM2 = '00000000-0000-0000-0000-0000000cffa2';
const PM_A = '00000000-0000-0000-0000-0000000cffb1';
const PM_B = '00000000-0000-0000-0000-0000000cffb2';
const PM_DEAD = '00000000-0000-0000-0000-0000000cffb3';
const ADMIN = '00000000-0000-0000-0000-0000000cffc1';
const PROJECT_A = '00000000-0000-0000-0000-0000000cffd1';
const PROJECT_B = '00000000-0000-0000-0000-0000000cffd2';

class FakePusher implements NotificationPusher {
  news: { userId: string; notification: NotificationView }[] = [];
  counts: { userId: string; unreadCount: number }[] = [];
  async pushNew(userId: string, _c: string, notification: NotificationView) { this.news.push({ userId, notification }); }
  async pushUnreadCount(userId: string, _c: string, unreadCount: number) { this.counts.push({ userId, unreadCount }); }
}

function configService() {
  const cfg: Record<string, string> = { JWT_SECRET, JWT_ACCESS_TTL: '900s', JWT_REFRESH_TTL: '7d' };
  return { getOrThrow: (k: string) => cfg[k], get: (k: string, d?: string) => cfg[k] ?? d } as any;
}
function actor(userId: string): Actor {
  return { userId, companyId: CO, financialYearId: FY, role: '', isUnscoped: false, assignedProjectIds: [], approvalLimit: null };
}
const emitCmd = (over?: any) => ({
  type: 'REQ_SUBMITTED', companyId: CO, title: 'Requisition awaiting approval', body: 'Karim submitted a requisition',
  sourceEntityType: 'Requisition', sourceEntityId: PROJECT_A, projectId: PROJECT_A,
  deepLink: { route: '/requisitions/approvals', params: { id: 'r1' } }, payload: { requisitionNo: 'REQ-1' },
  eventKey: 'evt-req-1', ...over,
});

describe('ntf-foundation (#40) — notifications store + emit + feed + gateway (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let resolver: SqlRecipientResolver;
  let repo: TypeOrmNotificationRepository;
  let service: NotificationService;
  let query: NotificationsQueryService;
  let pusher: FakePusher;
  let signer: JwtTokenSigner;

  const insertUser = async (id: string, email: string, role: string, active = true) => {
    await ds.query(
      `INSERT INTO "user" (id, company_id, financial_year_id, email, password_hash, name, role, is_active, must_change_password, version)
       VALUES ($1,$2,$3,$4,'x','U',$5,$6,false,1)`,
      [id, CO, FY, email, role, active],
    );
  };
  const assign = async (userId: string, projectId: string) =>
    ds.query(`INSERT INTO user_project (id, user_id, project_id, company_id) VALUES (gen_random_uuid(),$1,$2,$3)`, [userId, projectId, CO]);
  const insertProject = async (id: string, code: string, name: string) =>
    ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,'2025-07-01','2026-06-30','ACTIVE')`,
      [id, CO, code, name, crypto.randomUUID(), PM_A],
    );

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    ds = new DataSource({
      type: 'postgres', host: container.getHost(), port: container.getPort(),
      username: container.getUsername(), password: container.getPassword(), database: container.getDatabase(),
      synchronize: false,
      entities: [RoleOrmEntity, PermissionOrmEntity, UserOrmEntity, RefreshTokenOrmEntity],
      migrations: [
        InitialBaseline1700000000000, CreateCompanyFinancialYear1700000100000, CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000, CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000, CreateUser1700000700000, CreateRbacAndAudit1700000800000,
        RbacV2ResourcePermissions1700002300000, AddUserAvatar1700002400000, CreateNotification1700002500000,
      ],
    });
    await ds.initialize();
    await ds.runMigrations();

    await ds.query(`INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`, [CO]);
    await ds.query(`INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`, [FY, CO]);
    await insertProject(PROJECT_A, 'P-A', 'Meghna Bridge');
    await insertProject(PROJECT_B, 'P-B', 'Padma Link');
    await insertUser(AM1, 'am1@ze.local', 'ACCOUNTS_MANAGER');
    await insertUser(AM2, 'am2@ze.local', 'ACCOUNTS_MANAGER');
    await insertUser(PM_A, 'pma@ze.local', 'PROJECT_MANAGER');
    await insertUser(PM_B, 'pmb@ze.local', 'PROJECT_MANAGER');
    await insertUser(PM_DEAD, 'pmdead@ze.local', 'PROJECT_MANAGER', false);
    await insertUser(ADMIN, 'admin@ze.local', 'ADMIN');
    await assign(PM_A, PROJECT_A);
    await assign(PM_B, PROJECT_B);
    await assign(PM_DEAD, PROJECT_A);

    resolver = new SqlRecipientResolver(ds);
    repo = new TypeOrmNotificationRepository(ds);
    pusher = new FakePusher();
    service = new NotificationService(repo, resolver, pusher, new UuidIdGenerator());
    query = new NotificationsQueryService(ds);
    signer = new JwtTokenSigner(new JwtService({}), configService());
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  // ── recipient resolution (FR-NTF-017/018/020) ──
  describe('recipient resolution', () => {
    it('ROLE → all active holders company-wide', async () => {
      const ids = await resolver.resolve({ kind: 'ROLE', roles: ['ACCOUNTS_MANAGER'] }, { companyId: CO });
      expect(new Set(ids)).toEqual(new Set([AM1, AM2]));
    });
    it('PROJECT_ROLE → only active holders assigned to the project (excludes other-project + inactive)', async () => {
      const ids = await resolver.resolve({ kind: 'PROJECT_ROLE', roles: ['PROJECT_MANAGER'] }, { companyId: CO, projectId: PROJECT_A });
      expect(ids).toEqual([PM_A]); // not PM_B (project B), not PM_DEAD (inactive)
    });
    it('USER → the affected user when active; empty when inactive', async () => {
      expect(await resolver.resolve({ kind: 'USER' }, { companyId: CO, affectedUserId: AM1 })).toEqual([AM1]);
      expect(await resolver.resolve({ kind: 'USER' }, { companyId: CO, affectedUserId: PM_DEAD })).toEqual([]);
    });
  });

  // ── emit fan-out + idempotency (FR-NTF-002/019) ──
  it('emit fans out one row per resolved recipient and pushes each (FR-NTF-002/010)', async () => {
    const res = await service.emit(emitCmd());
    // REQ_SUBMITTED = PROJECT_ROLE(PM) + ROLE(AM) → PM_A + AM1 + AM2 (PM_DEAD excluded).
    expect(res.created).toBe(3);
    const rows = await ds.query(`SELECT recipient_user_id AS u, is_read FROM notification WHERE event_key = 'evt-req-1'`);
    expect(new Set(rows.map((r: any) => r.u))).toEqual(new Set([PM_A, AM1, AM2]));
    expect(rows.every((r: any) => r.is_read === false)).toBe(true);
    expect(pusher.news.map(n => n.userId).sort()).toEqual([AM1, AM2, PM_A].sort());
  });

  it('re-emitting the same (recipient, eventKey) creates nothing (idempotent, FR-NTF-019)', async () => {
    const before = await ds.query(`SELECT count(*)::int AS c FROM notification WHERE event_key = 'evt-req-1'`);
    const res = await service.emit(emitCmd());
    expect(res.created).toBe(0);
    const after = await ds.query(`SELECT count(*)::int AS c FROM notification WHERE event_key = 'evt-req-1'`);
    expect(after[0].c).toBe(before[0].c);
  });

  // ── REST feed (FR-NTF-004/005/013/014/015) ──
  describe('feed', () => {
    it('list is self-scoped + most-recent-first; unread-count matches; filters by isRead/type', async () => {
      const page = await query.list(actor(AM1), { page: 1, pageSize: 25 });
      expect(page.items.length).toBeGreaterThanOrEqual(1);
      expect(page.items[0].type).toBe('REQ_SUBMITTED');
      expect(page.items[0].deepLink).toMatchObject({ route: '/requisitions/approvals' });
      expect(await query.unreadCount(actor(AM1))).toBe(page.total);
      const unreadOnly = await query.list(actor(AM1), { isRead: false, page: 1, pageSize: 25 });
      expect(unreadOnly.total).toBe(page.total);
      const wrongType = await query.list(actor(AM1), { type: 'PERIOD_CLOSED', page: 1, pageSize: 25 });
      expect(wrongType.total).toBe(0);
    });

    it('getForRecipient returns own rows; a foreign row → null (FR-NTF-003)', async () => {
      const [own] = await ds.query(`SELECT id FROM notification WHERE recipient_user_id = $1 LIMIT 1`, [AM1]);
      expect(await query.getForRecipient(actor(AM1), own.id)).not.toBeNull();
      expect(await query.getForRecipient(actor(AM2), own.id)).toBeNull(); // AM2 cannot see AM1's row
    });

    it('markOneRead is idempotent + self-scoped; markAllRead clears the rest', async () => {
      const [own] = await ds.query(`SELECT id FROM notification WHERE recipient_user_id = $1 AND is_read = false LIMIT 1`, [AM1]);
      await expect(service.markOneRead(actor(AM2), own.id)).rejects.toBeInstanceOf(NotFoundException); // foreign → 404
      const first = await service.markOneRead(actor(AM1), own.id);
      const again = await service.markOneRead(actor(AM1), own.id); // idempotent
      expect(first.readAt).toBe(again.readAt);
      const all = await service.markAllRead(actor(AM1));
      expect(all.updated).toBeGreaterThanOrEqual(0);
      expect(await query.unreadCount(actor(AM1))).toBe(0);
    });
  });

  // ── WebSocket gateway handshake (FR-NTF-008/009) ──
  describe('gateway', () => {
    function mockSocket(token?: string) {
      const joined: string[] = []; const emitted: { e: string; p: any }[] = []; let disconnected = false;
      const socket = {
        handshake: { auth: token ? { token } : {}, headers: {} },
        join: (r: string) => joined.push(r),
        emit: (e: string, p: any) => emitted.push({ e, p }),
        disconnect: () => { disconnected = true; },
      };
      return { socket, joined, emitted, get disconnected() { return disconnected; } };
    }

    it('a valid token joins the caller’s room + seeds the unread count', async () => {
      const gw = new NotificationsGateway(signer, repo);
      const token = signer.signAccess({ sub: AM2, companyId: CO, financialYearId: FY, role: 'ACCOUNTS_MANAGER' });
      const m = mockSocket(token);
      await gw.handleConnection(m.socket as any);
      expect(m.joined).toEqual([roomFor(CO, AM2)]);
      expect(m.emitted[0].e).toBe('connected');
      expect(typeof m.emitted[0].p.unreadCount).toBe('number');
    });

    it('a missing/invalid token is rejected (no room join)', async () => {
      const gw = new NotificationsGateway(signer, repo);
      const bad = mockSocket('not-a-jwt');
      await gw.handleConnection(bad.socket as any);
      expect(bad.joined).toEqual([]);
      expect(bad.emitted.some(e => e.e === 'connect_error')).toBe(true);
      expect(bad.disconnected).toBe(true);

      const none = mockSocket(undefined);
      await gw.handleConnection(none.socket as any);
      expect(none.joined).toEqual([]);
      expect(none.disconnected).toBe(true);
    });

    it('pushNew / pushUnreadCount emit to the recipient room only', async () => {
      const gw = new NotificationsGateway(signer, repo);
      const emits: { room: string; e: string; p: any }[] = [];
      gw.server = { to: (room: string) => ({ emit: (e: string, p: any) => emits.push({ room, e, p }) }) } as any;
      await gw.pushNew(PM_A, CO, { id: 'x' } as any);
      await gw.pushUnreadCount(PM_A, CO, 4);
      expect(emits[0]).toMatchObject({ room: roomFor(CO, PM_A), e: 'notification:new' });
      expect(emits[1]).toMatchObject({ room: roomFor(CO, PM_A), e: 'notification:unreadCount', p: { unreadCount: 4 } });
    });
  });

  // ── guard smoke (§13) ──
  describe('guard smoke — NotificationsController carries real guards', () => {
    it('declares @UseGuards (JwtAuthGuard + RolesGuard)', () => {
      const guards = Reflect.getMetadata('__guards__', NotificationsController) ?? [];
      expect(guards.map((g: any) => g.name)).toEqual(expect.arrayContaining(['JwtAuthGuard', 'RolesGuard']));
    });
    it('the feed route passes RolesGuard for an authenticated user (no permission gate)', async () => {
      const guard = new RolesGuard(new Reflector(), new TypeOrmRoleRepository(ds), new TypeOrmPermissionRepository(ds));
      const ctx = {
        getHandler: () => NotificationsController.prototype.list,
        getClass: () => NotificationsController,
        switchToHttp: () => ({ getRequest: () => ({ user: actor(AM1) }) }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });
});
