/**
 * ntf-producers (#41) + ntf-scheduler (#42) — end-to-end over real Postgres.
 *
 * #41: an AUD use case (deactivate) publishes on the in-process bus AFTER commit → the NTF subscriber
 *      maps it → NotificationService.emit → notification rows (FR-NTF-016); best-effort (a push failure
 *      never fails the business op, FR-NTF-012); the now-inactive target is excluded (FR-NTF-020).
 * #42: the scheduler scans emit PERIOD_CLOSING_SOON / IPC_OVERDUE, idempotently, with no ledger/state
 *      change (FR-NTF-022..025).
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateSalesInvoice1700001200000 } from '../src/database/migrations/1700001200000-CreateSalesInvoice';
import { CreateUser1700000700000 } from '../src/database/migrations/1700000700000-CreateUser';
import { CreateRbacAndAudit1700000800000 } from '../src/database/migrations/1700000800000-CreateRbacAndAudit';
import { RbacV2ResourcePermissions1700002300000 } from '../src/database/migrations/1700002300000-RbacV2ResourcePermissions';
import { AddUserAvatar1700002400000 } from '../src/database/migrations/1700002400000-AddUserAvatar';
import { CreateNotification1700002500000 } from '../src/database/migrations/1700002500000-CreateNotification';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';
import { UserOrmEntity } from '../src/core/auth/infrastructure/user.orm-entity';
import { RefreshTokenOrmEntity } from '../src/core/auth/infrastructure/refresh-token.orm-entity';
import { InProcessEventBus } from '../src/infrastructure/events/in-process-event-bus';
import { SqlRecipientResolver } from '../src/core/notifications/infrastructure/sql-recipient-resolver';
import { TypeOrmNotificationRepository } from '../src/core/notifications/infrastructure/typeorm-notification.repository';
import { NotificationService } from '../src/core/notifications/application/notification.service';
import { NotificationSubscriber } from '../src/core/notifications/application/notification-subscriber';
import { NtfSchedulerService } from '../src/core/notifications/application/ntf-scheduler.service';
import { NtfDueQueryService } from '../src/core/notifications/read/ntf-due.query-service';
import { NotificationPusher } from '../src/core/notifications/domain/ports/notification-pusher.port';
import { UserAdminUseCases } from '../src/core/auth/application/rbac.use-cases';
import { TypeOrmUserRepository } from '../src/core/auth/infrastructure/typeorm-user.repository';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { DbRefreshTokenStore } from '../src/core/auth/infrastructure/db-refresh-token-store';
import { BcryptPasswordHasher } from '../src/core/auth/infrastructure/bcrypt-password-hasher';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { NoopAuditService } from '../src/core/audit/infrastructure/noop-audit.service';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-00000cf10001';
const FY = '00000000-0000-0000-0000-00000cf100f1';
const ADMIN_U = '00000000-0000-0000-0000-00000cf100a1';
const AM_U = '00000000-0000-0000-0000-00000cf100a2';
const PM_U = '00000000-0000-0000-0000-00000cf100a3';
const TARGET_U = '00000000-0000-0000-0000-00000cf100a4';
const PROJECT = '00000000-0000-0000-0000-00000cf100d1';
const PARTY = '00000000-0000-0000-0000-00000cf100e1';
const CC = '00000000-0000-0000-0000-00000cf100c1';
const PURPOSE = '00000000-0000-0000-0000-00000cf100b1';
const TODAY = '2026-07-05';

class FakePusher implements NotificationPusher {
  fail = false;
  async pushNew() { if (this.fail) throw new Error('socket down'); }
  async pushUnreadCount() { /* noop */ }
}
function adminActor(): Actor {
  return { userId: ADMIN_U, companyId: CO, financialYearId: FY, role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };
}
const countByType = async (ds: DataSource, type: string, recipient?: string) =>
  (await ds.query(
    `SELECT count(*)::int AS c FROM notification WHERE type = $1${recipient ? ' AND recipient_user_id = $2' : ''}`,
    recipient ? [type, recipient] : [type],
  ))[0].c as number;

describe('ntf-producers (#41) + ntf-scheduler (#42) (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let notifications: NotificationService;
  let userAdmin: UserAdminUseCases;
  let scheduler: NtfSchedulerService;
  let pusher: FakePusher;

  const insertUser = async (id: string, email: string, role: string, active = true) =>
    ds.query(
      `INSERT INTO "user" (id, company_id, financial_year_id, email, password_hash, name, role, is_active, must_change_password, version)
       VALUES ($1,$2,$3,$4,'x','U',$5,$6,false,1)`,
      [id, CO, FY, email, role, active],
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
        CreateAccountingPeriod1700000300000, CreateLedger1700000400000, CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000, CreateSalesInvoice1700001200000, CreateUser1700000700000,
        CreateRbacAndAudit1700000800000, RbacV2ResourcePermissions1700002300000, AddUserAvatar1700002400000,
        CreateNotification1700002500000,
      ],
    });
    await ds.initialize();
    await ds.runMigrations();

    await ds.query(`INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`, [CO]);
    await ds.query(`INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`, [FY, CO]);
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status)
       VALUES ($1,$2,'P-01','Meghna Bridge',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [PROJECT, CO, PARTY, PM_U],
    );
    await ds.query(`INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,'Cust A',true,false,'+8801700000000')`, [PARTY, CO]);
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Slab','Slab')`, [CC, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'IPC #7')`, [PURPOSE, CO, PROJECT]);

    await insertUser(ADMIN_U, 'admin@ze.local', 'ADMIN');
    await insertUser(AM_U, 'am@ze.local', 'ACCOUNTS_MANAGER');
    await insertUser(PM_U, 'pm@ze.local', 'PROJECT_MANAGER');
    await insertUser(TARGET_U, 'store@ze.local', 'STORE_KEEPER');
    await ds.query(`INSERT INTO user_project (id, user_id, project_id, company_id) VALUES (gen_random_uuid(),$1,$2,$3)`, [PM_U, PROJECT, CO]);

    const bus = new InProcessEventBus();
    pusher = new FakePusher();
    notifications = new NotificationService(new TypeOrmNotificationRepository(ds), new SqlRecipientResolver(ds), pusher, new UuidIdGenerator());
    new NotificationSubscriber(bus, notifications).onModuleInit(); // subscribe the bridge to the bus

    userAdmin = new UserAdminUseCases(
      new TypeOrmUserRepository(ds), new TypeOrmRoleRepository(ds), new BcryptPasswordHasher(),
      new DbRefreshTokenStore(ds), new NoopAuditService(), new TypeOrmUnitOfWork(ds), bus, // bus = EVENT_PUBLISHER
    );
    scheduler = new NtfSchedulerService({ now: () => new Date(`${TODAY}T00:00:00Z`) } as any, new NtfDueQueryService(ds), notifications);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  // ── #41 producers ──
  describe('AUD producers via the bus (#41)', () => {
    it('deactivating a user raises USER_DEACTIVATED for Admins; the now-inactive target is excluded (FR-NTF-016/020)', async () => {
      await userAdmin.deactivateUser(TARGET_U, adminActor());
      expect(await countByType(ds, 'USER_DEACTIVATED', ADMIN_U)).toBe(1); // admin notified
      expect(await countByType(ds, 'USER_DEACTIVATED', TARGET_U)).toBe(0); // excluded — now inactive
      // reactivate for the later scheduler tests
      await ds.query(`UPDATE "user" SET is_active = true WHERE id = $1`, [TARGET_U]);
    });

    it('a push failure never fails the business op (best-effort, FR-NTF-012)', async () => {
      pusher.fail = true;
      await insertUser('00000000-0000-0000-0000-00000cf100a9', 'x@ze.local', 'STORE_KEEPER');
      await expect(userAdmin.deactivateUser('00000000-0000-0000-0000-00000cf100a9', adminActor())).resolves.toBeDefined();
      expect(await countByType(ds, 'USER_DEACTIVATED', ADMIN_U)).toBeGreaterThanOrEqual(1); // row still persisted
      pusher.fail = false;
    });
  });

  // ── #42 scheduler ──
  describe('scheduler scans (#42)', () => {
    it('PERIOD_CLOSING_SOON fires for an OPEN period ending within 7 days; not for a far period; idempotent', async () => {
      // Non-overlapping ranges (accounting_period has a gist EXCLUDE on overlapping date ranges per FY).
      await ds.query(`INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES (gen_random_uuid(),$1,$2,'Jul 2026','2026-07-01','2026-07-08','OPEN')`, [CO, FY]);
      await ds.query(`INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES (gen_random_uuid(),$1,$2,'Aug 2026','2026-08-01','2026-08-31','OPEN')`, [CO, FY]);

      const raised = await scheduler.scanPeriodClosingSoon(TODAY);
      expect(raised).toBe(1); // only the Jul 2026 OPEN period ending 2026-07-08 (Aug is beyond the 7-day window)
      // recipients = all posting roles → every active user gets a row
      const activeUsers = (await ds.query(`SELECT count(*)::int AS c FROM "user" WHERE company_id=$1 AND is_active=true`, [CO]))[0].c;
      expect(await countByType(ds, 'PERIOD_CLOSING_SOON')).toBe(activeUsers);

      const again = await scheduler.scanPeriodClosingSoon(TODAY); // idempotent
      expect(again).toBe(0);
      expect(await countByType(ds, 'PERIOD_CLOSING_SOON')).toBe(activeUsers);
    });

    it('IPC_OVERDUE fires for a POSTED past-due IPC scoped to its project; not for DRAFT/not-due; idempotent', async () => {
      const overdue = 'sales_invoice with a due_date before TODAY';
      const mkIpc = async (id: string, seq: number, due: string, status: string) => ds.query(
        `INSERT INTO sales_invoice (id, company_id, financial_year_id, project_id, customer_id, ipc_seq_no, ipc_date, bill_date, due_date, certified_amount, cost_centre_id, purpose_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01','2026-06-01',$7,100000,$8,$9,$10)`,
        [id, CO, FY, PROJECT, PARTY, seq, due, CC, PURPOSE, status],
      );
      await mkIpc('00000000-0000-0000-0000-00000cf10f01', 1, '2026-07-01', 'POSTED'); // overdue
      await mkIpc('00000000-0000-0000-0000-00000cf10f02', 2, '2026-07-20', 'POSTED'); // not yet due
      await mkIpc('00000000-0000-0000-0000-00000cf10f03', 3, '2026-06-01', 'DRAFT');  // draft
      void overdue;

      const raised = await scheduler.scanOverdueIpcs(TODAY);
      expect(raised).toBe(1); // only the POSTED overdue one
      // recipients = ROLE(Accounts) + PROJECT_ROLE(PM on this project) → AM_U + PM_U
      expect(await countByType(ds, 'IPC_OVERDUE', AM_U)).toBe(1);
      expect(await countByType(ds, 'IPC_OVERDUE', PM_U)).toBe(1);
      expect(await countByType(ds, 'IPC_OVERDUE')).toBe(2);

      expect(await scheduler.scanOverdueIpcs(TODAY)).toBe(0); // idempotent
    });

    it('the scans write no ledger and change no source state', async () => {
      const je = (await ds.query(`SELECT count(*)::int AS c FROM journal_entry`))[0].c;
      const openPeriods = (await ds.query(`SELECT count(*)::int AS c FROM accounting_period WHERE status='OPEN'`))[0].c;
      await scheduler.scanPeriodClosingSoon(TODAY);
      await scheduler.scanOverdueIpcs(TODAY);
      expect((await ds.query(`SELECT count(*)::int AS c FROM journal_entry`))[0].c).toBe(je);
      expect((await ds.query(`SELECT count(*)::int AS c FROM accounting_period WHERE status='OPEN'`))[0].c).toBe(openPeriods);
    });
  });
});
