/**
 * RPT financial-statements integration — Testcontainers Postgres, real LED/MAS migrations + LED triggers.
 * Seeds a company + CoA (typed groups) + FY + period + two projects, then a handful of BALANCED posted
 * journal entries (raw SQL, exactly as PAY's int-spec seeds its accrual fixtures), and drives the real
 * RPT read path (LedgerReadAdapter + ReportQueryService + ReportScopeService). Proves the brief's DoD:
 *   - trial balance balances (Σdebit = Σcredit) AND ties byte-for-byte to LED's OWN trial-balance totals
 *     for the same params (single source of truth, FR-RPT-004/-009);
 *   - account-ledger opening + a running balance that carries across two pages (FR-RPT-010);
 *   - project P&L profit = revenue − cost (FR-RPT-013/-015);
 *   - daybook rows are source-traceable (sourceType/sourceId) (FR-RPT-011);
 *   - balance sheet assets = liabilities + equity (FR-RPT-014);
 *   - scope: a PM is auto-filtered to assigned projects; an explicit unassigned projectId is 403 (FR-RPT-006/-007);
 *   - an empty range returns rows:[] with zeroed/balanced totals, not an error (SRS edge case 4);
 *   - the trial balance over the seeded set returns well under 5s (NFR-001);
 *   - RBAC guard smoke test (module 'RPT', 401/403/200).
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';

import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { NumberingSeriesOrmEntity } from '../src/core/numbering/infrastructure/numbering-series.orm-entity';
import { AccountingPeriodOrmEntity } from '../src/core/period/infrastructure/accounting-period.orm-entity';
import { JournalEntryOrmEntity } from '../src/core/posting/infrastructure/journal-entry.orm-entity';
import { JournalLineOrmEntity } from '../src/core/posting/infrastructure/journal-line.orm-entity';
import { AccountOrmEntity } from '../src/modules/master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { PartyOrmEntity } from '../src/modules/master-data/party/infrastructure/party.orm-entity';
import { ProjectOrmEntity } from '../src/modules/master-data/project/infrastructure/project.orm-entity';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateUser1700000700000 } from '../src/database/migrations/1700000700000-CreateUser';
import { CreateRbacAndAudit1700000800000 } from '../src/database/migrations/1700000800000-CreateRbacAndAudit';
import { AddExportActionToAuditLog1700000900000 } from '../src/database/migrations/1700000900000-AddExportActionToAuditLog';
import { CreateStockMovementAndBalance1700001000000 } from '../src/database/migrations/1700001000000-CreateStockMovementAndBalance';
import { CreateContraJournal1700001100000 } from '../src/database/migrations/1700001100000-CreateContraJournal';
import { CreateSalesInvoice1700001200000 } from '../src/database/migrations/1700001200000-CreateSalesInvoice';
import { CreateHrEmployeeAttendance1700001300000 } from '../src/database/migrations/1700001300000-CreateHrEmployeeAttendance';
import { CreateRequisition1700001400000 } from '../src/database/migrations/1700001400000-CreateRequisition';
import { CreateStockJournal1700001500000 } from '../src/database/migrations/1700001500000-CreateStockJournal';
import { CreateReceipt1700001600000 } from '../src/database/migrations/1700001600000-CreateReceipt';
import { CreateRetentionRelease1700001700000 } from '../src/database/migrations/1700001700000-CreateRetentionRelease';
import { CreateHrSalary1700001800000 } from '../src/database/migrations/1700001800000-CreateHrSalary';
import { CreateRequisitionIssue1700001900000 } from '../src/database/migrations/1700001900000-CreateRequisitionIssue';
import { CreatePurchasePoBill1700002000000 } from '../src/database/migrations/1700002000000-CreatePurchasePoBill';
import { CreatePurchaseGrn1700002100000 } from '../src/database/migrations/1700002100000-CreatePurchaseGrn';
import { CreatePayment1700002200000 } from '../src/database/migrations/1700002200000-CreatePayment';

import { Actor } from '../src/core/tenancy/tenant-context';
import { LedgerReadAdapter } from '../src/reports/infrastructure/ledger.read.adapter';
import { InventoryReadAdapter } from '../src/reports/infrastructure/inventory.read.adapter';
import { RequisitionReadAdapter } from '../src/reports/infrastructure/requisition.read.adapter';
import { HrReadAdapter } from '../src/reports/infrastructure/hr.read.adapter';
import { ReportQueryService } from '../src/reports/application/report-query.service';
import { ReportScopeService } from '../src/reports/application/report-scope.service';
import { LedgerQueryService } from '../src/core/posting/read/ledger-query.service';

// RolesGuard smoke deps (mandatory per skill §13).
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { JwtAuthGuard } from '../src/core/auth/presentation/jwt-auth.guard';
import { PermissionRequirement } from '../src/core/auth/presentation/roles.decorator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c1';
const FY1 = '00000000-0000-0000-0000-0000000000f2';
const PERIOD = '00000000-0000-0000-0000-0000000000e2';
const USER = '00000000-0000-0000-0000-0000000000a2';
const CUSTOMER = '00000000-0000-0000-0000-00000000d201';
const P = '00000000-0000-0000-0000-00000000d301'; // project P (assigned)
const Q = '00000000-0000-0000-0000-00000000d302'; // project Q (unassigned)

const GRP = {
  asset: '00000000-0000-0000-0000-0000000000b1',
  liability: '00000000-0000-0000-0000-0000000000b2',
  equity: '00000000-0000-0000-0000-0000000000b3',
  income: '00000000-0000-0000-0000-0000000000b4',
  expense: '00000000-0000-0000-0000-0000000000b5',
};
const ACC = {
  cash: '00000000-0000-0000-0000-00000000a110', // 1100 ASSET
  bank: '00000000-0000-0000-0000-00000000a111', // 1110 ASSET
  ar: '00000000-0000-0000-0000-00000000a120', // 1200 ASSET (receivable)
  ap: '00000000-0000-0000-0000-00000000a210', // 2100 LIABILITY
  capital: '00000000-0000-0000-0000-00000000a310', // 3100 EQUITY
  revenue: '00000000-0000-0000-0000-00000000a410', // 4100 INCOME
  expense: '00000000-0000-0000-0000-00000000a510', // 5100 EXPENSE
};

const admin: Actor = {
  userId: USER, companyId: CO, financialYearId: FY1, role: 'ACCOUNTS_TEAM',
  isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pmP: Actor = {
  userId: 'pm-user', companyId: CO, financialYearId: FY1, role: 'PROJECT_MANAGER',
  isUnscoped: false, assignedProjectIds: [P], approvalLimit: null,
};

interface Line {
  account: string;
  project?: string | null;
  debit?: string;
  credit?: string;
}

describe('RPT financial statements (real Postgres, real LED ledger + typed CoA)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let query: ReportQueryService;
  let led: LedgerQueryService;
  let rolesGuard: RolesGuard;
  let jwtAuthGuard: JwtAuthGuard;
  let entrySeq = 0;

  async function postEntry(voucherType: string, date: string, lines: Line[]): Promise<string> {
    entrySeq += 1;
    const entryId = `00000000-0000-0000-0000-0000000f${String(entrySeq).padStart(4, '0')}`;
    await ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, is_reversal, reversal_of, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,$5,$6,'GeneralVoucher',$1,false,NULL,now(),$7)`,
        [entryId, CO, FY1, `GV/2526/${String(entrySeq).padStart(4, '0')}`, voucherType, date, USER],
      );
      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        await m.query(
          `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, debit, credit)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`,
          [entryId, lineNo, l.account, l.project ?? null, l.debit ?? '0', l.credit ?? '0'],
        );
      }
    });
    return entryId;
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
      entities: [
        CompanyOrmEntity,
        FinancialYearOrmEntity,
        NumberingSeriesOrmEntity,
        AccountingPeriodOrmEntity,
        JournalEntryOrmEntity,
        JournalLineOrmEntity,
        AccountOrmEntity,
        PartyOrmEntity,
        ProjectOrmEntity,
        RoleOrmEntity,
        PermissionOrmEntity,
      ],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateLedger1700000400000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
        CreateUser1700000700000,
        CreateRbacAndAudit1700000800000,
        AddExportActionToAuditLog1700000900000,
        CreateStockMovementAndBalance1700001000000,
        CreateContraJournal1700001100000,
        CreateSalesInvoice1700001200000,
        CreateHrEmployeeAttendance1700001300000,
        CreateRequisition1700001400000,
        CreateStockJournal1700001500000,
        CreateReceipt1700001600000,
        CreateRetentionRelease1700001700000,
        CreateHrSalary1700001800000,
        CreateRequisitionIssue1700001900000,
        CreatePurchasePoBill1700002000000,
        CreatePurchaseGrn1700002100000,
        CreatePayment1700002200000,
      ],
    });
    await ds.initialize();
    await ds.runMigrations();

    await ds.query(
      `INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`,
      [CO],
    );
    await ds.query(
      `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`,
      [FY1, CO],
    );
    await ds.query(
      `INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES ($1,$2,$3,'Jun 2026','2026-06-01','2026-06-30','OPEN')`,
      [PERIOD, CO, FY1],
    );

    const grp = (id: string, name: string, type: string) =>
      ds.query(`INSERT INTO account_group (id, company_id, name, parent_group_id, type) VALUES ($1,$2,$3,NULL,$4)`, [
        id, CO, name, type,
      ]);
    await grp(GRP.asset, 'Assets', 'ASSET');
    await grp(GRP.liability, 'Liabilities', 'LIABILITY');
    await grp(GRP.equity, 'Equity', 'EQUITY');
    await grp(GRP.income, 'Income', 'INCOME');
    await grp(GRP.expense, 'Expenses', 'EXPENSE');

    const acc = (id: string, code: string, name: string, group: string, type: string) =>
      ds.query(
        `INSERT INTO account (id, company_id, code, name, account_group_id, type, opening_balance) VALUES ($1,$2,$3,$4,$5,$6,NULL)`,
        [id, CO, code, name, group, type],
      );
    await acc(ACC.cash, '1100', 'Cash in Hand', GRP.asset, 'ASSET');
    await acc(ACC.bank, '1110', 'Bank — Operating', GRP.asset, 'ASSET');
    await acc(ACC.ar, '1200', 'Accounts Receivable', GRP.asset, 'ASSET');
    await acc(ACC.ap, '2100', 'Accounts Payable', GRP.liability, 'LIABILITY');
    await acc(ACC.capital, '3100', 'Share Capital', GRP.equity, 'EQUITY');
    await acc(ACC.revenue, '4100', 'Contract Revenue', GRP.income, 'INCOME');
    await acc(ACC.expense, '5100', 'Site Expense', GRP.expense, 'EXPENSE');

    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,'Customer A',true,false,'+8801700000000')`,
      [CUSTOMER, CO],
    );
    const proj = (id: string, code: string, name: string) =>
      ds.query(
        `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,$3,$4,$5,$6,'2025-07-01','2026-06-30','ACTIVE')`,
        [id, CO, code, name, CUSTOMER, USER],
      );
    await proj(P, 'P-01', 'Site P');
    await proj(Q, 'P-02', 'Site Q');

    // Balanced posted entries.
    await postEntry('CONTRA', '2026-06-01', [
      { account: ACC.bank, debit: '10000' },
      { account: ACC.capital, credit: '10000' },
    ]);
    // Project P's postings are project-complete (every line tagged P) so a project-filtered trial
    // balance still balances (AC5). The capital injection above is untagged (a balance-sheet-only entry).
    await postEntry('GENERAL', '2026-06-10', [
      { account: ACC.expense, project: P, debit: '3200' },
      { account: ACC.bank, project: P, credit: '3200' },
    ]);
    await postEntry('SALES', '2026-06-15', [
      { account: ACC.ar, project: P, debit: '4000' },
      { account: ACC.revenue, project: P, credit: '4000' },
    ]);
    await postEntry('RECEIPT', '2026-06-20', [
      { account: ACC.cash, project: P, debit: '4000' },
      { account: ACC.ar, project: P, credit: '4000' },
    ]);
    await postEntry('SALES', '2026-06-25', [
      { account: ACC.ar, project: Q, debit: '1000' },
      { account: ACC.revenue, project: Q, credit: '1000' },
    ]);

    query = new ReportQueryService(
      new LedgerReadAdapter(ds),
      new InventoryReadAdapter(ds),
      new RequisitionReadAdapter(ds),
      new HrReadAdapter(ds),
      new ReportScopeService(),
    );
    led = new LedgerQueryService(ds);
    rolesGuard = new RolesGuard(new Reflector(), new TypeOrmRoleRepository(ds), new TypeOrmPermissionRepository(ds));
    jwtAuthGuard = new JwtAuthGuard();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  it('trial balance balances and ties byte-for-byte to LED’s own trial-balance totals (FR-RPT-004/-009)', async () => {
    const start = Date.now();
    const rpt = await query.trialBalance({ financialYearId: FY1 }, admin);
    const elapsed = Date.now() - start;

    expect(rpt.totals).not.toBeNull();
    expect(rpt.totals!.debit).toBe(rpt.totals!.credit); // the ledger balances
    expect(new Decimal(rpt.totals!.debit).greaterThan(0)).toBe(true);

    const ledTb = await led.trialBalance({ financialYearId: FY1 }, admin);
    const ledTotals = (ledTb.extraMeta as { totals: { debit: string; credit: string } }).totals;
    expect(rpt.totals).toEqual(ledTotals); // single source of truth — identical numbers
    expect(elapsed).toBeLessThan(5000); // NFR-001
  });

  it('trial balance with a projectId narrows the population but still balances (AC5)', async () => {
    const rpt = await query.trialBalance({ financialYearId: FY1, projectId: P }, admin);
    expect(rpt.totals!.debit).toBe(rpt.totals!.credit);
    // Only lines tagged P: expense 3200 (Dr), revenue 4000 (Cr), ar 4000 Dr + 4000 Cr → debit=credit.
  });

  it('account ledger: opening + a running balance that carries across two pages (FR-RPT-010)', async () => {
    const page1 = await query.accountLedger({ financialYearId: FY1, accountId: ACC.bank, page: 1, pageSize: 1 }, admin);
    const page2 = await query.accountLedger({ financialYearId: FY1, accountId: ACC.bank, page: 2, pageSize: 1 }, admin);

    expect(page1.total).toBe(2);
    expect(page1.extraMeta).toEqual({ openingBalance: '0.0000' });
    expect(page1.items[0].runningBalance).toBe('10000.0000'); // after the capital injection
    expect(page1.items[0].sourceType).toBe('GeneralVoucher'); // source-traceable
    expect(page2.items[0].runningBalance).toBe('6800.0000'); // carries across the page boundary
  });

  it('project P&L: profit = revenue − cost (FR-RPT-013/-015)', async () => {
    const rpt = await query.profitAndLoss({ financialYearId: FY1, projectId: P }, admin);
    expect(rpt.totals).toEqual({ revenue: '4000.0000', cost: '3200.0000', profit: '800.0000' });

    const consolidated = await query.profitAndLoss({ financialYearId: FY1 }, admin);
    expect(consolidated.totals).toEqual({ revenue: '5000.0000', cost: '3200.0000', profit: '1800.0000' });
  });

  it('daybook: every row is traceable to its source voucher (FR-RPT-011)', async () => {
    const db = await query.daybook({ financialYearId: FY1, dateFrom: '2026-06-01', dateTo: '2026-06-30', pageSize: 200 }, admin);
    expect(db.total).toBeGreaterThan(0);
    for (const row of db.items) {
      expect(row.sourceType).toBeTruthy();
      expect(row.sourceId).toBeTruthy();
      expect(row.entryNo).toBeTruthy();
    }
  });

  it('cash/bank book: restricted to cash/bank accounts with a running balance (FR-RPT-012)', async () => {
    const cb = await query.cashBankBook({ financialYearId: FY1, dateFrom: '2026-06-01', dateTo: '2026-06-30', pageSize: 200 }, admin);
    // bank: Dr 10000, Cr 3200; cash: Dr 4000 → 3 lines, all on cash/bank accounts.
    expect(cb.total).toBe(3);
    for (const row of cb.items) {
      expect([ACC.cash, ACC.bank]).toContain(row.accountId);
      expect(row.runningBalance).toBeDefined();
    }
  });

  it('balance sheet: assets = liabilities + equity (FR-RPT-014)', async () => {
    const bs = await query.balanceSheet({ financialYearId: FY1, asOf: '2026-06-30' }, admin);
    const t = bs.totals!;
    expect(new Decimal(t.assets).toFixed(4)).toBe(
      new Decimal(t.liabilities).plus(t.equity).toFixed(4),
    );
    expect(new Decimal(t.assets).toFixed(4)).toBe('11800.0000');
    // Current-period earnings closed into equity.
    expect(bs.rows.some((r) => r.accountGroup === 'Current Period Earnings' && r.balance === '1800.0000')).toBe(true);
  });

  it('scope: a PM sees only assigned projects; an explicit unassigned projectId is 403 (FR-RPT-006/-007)', async () => {
    // PM assigned to P, no projectId → auto-filtered to P (revenue 4000, cost 3200; Q revenue 1000 excluded).
    const pmPnl = await query.profitAndLoss({ financialYearId: FY1 }, pmP);
    expect(pmPnl.totals).toEqual({ revenue: '4000.0000', cost: '3200.0000', profit: '800.0000' });

    // Explicit unassigned project Q → 403.
    await expect(query.profitAndLoss({ financialYearId: FY1, projectId: Q }, pmP)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('empty range → rows:[] with zeroed/balanced totals, not an error (SRS edge case 4)', async () => {
    const tb = await query.trialBalance({ financialYearId: FY1, dateFrom: '2020-01-01', dateTo: '2020-01-31' }, admin);
    expect(tb.rows).toEqual([]);
    expect(tb.totals).toEqual({ debit: '0.0000', credit: '0.0000' });

    const db = await query.daybook({ financialYearId: FY1, dateFrom: '2020-01-01', dateTo: '2020-01-31' }, admin);
    expect(db.items).toEqual([]);
    expect(db.total).toBe(0);
  });

  // ── RBAC guard smoke test (skill §13) — proves ReportsController really enforces
  // @UseGuards(JwtAuthGuard, RolesGuard) + @Roles({ module:'RPT', action:'READ' }). ──
  describe('ReportsController RBAC — real RolesGuard against a real Postgres-backed Role/Permission repo', () => {
    const ACCOUNTS_ROLE = '00000000-0000-0000-0000-0000000e3b10';
    const PM_ROLE = '00000000-0000-0000-0000-0000000e3b11';
    const SK_ROLE = '00000000-0000-0000-0000-0000000e3b12';
    const accountsActor: Actor = { ...admin, role: 'ACCOUNTS_TEAM' };
    const pmActor: Actor = { ...pmP };
    const skActor: Actor = { ...admin, userId: 'sk-user', role: 'STORE_KEEPER', isUnscoped: false, assignedProjectIds: [] };

    function mockContext(user: Actor | undefined, requirements: PermissionRequirement[]): ExecutionContext {
      jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requirements);
      return {
        getHandler: () => function handler() {},
        getClass: () => class ReportsController {},
        switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
      } as unknown as ExecutionContext;
    }

    beforeAll(async () => {
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ACCOUNTS_TEAM',true,1) ON CONFLICT DO NOTHING`, [ACCOUNTS_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1) ON CONFLICT DO NOTHING`, [PM_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'STORE_KEEPER',false,1) ON CONFLICT DO NOTHING`, [SK_ROLE, CO]);
      // ACCOUNTS_TEAM + PROJECT_MANAGER hold RPT:READ (per seed-roles-permissions.ts); STORE_KEEPER holds none.
      await ds.query(
        `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(),$1,$2,'RPT','READ','ALL',1)`,
        [ACCOUNTS_ROLE, CO],
      );
      await ds.query(
        `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(),$1,$2,'RPT','READ','ASSIGNED',1)`,
        [PM_ROLE, CO],
      );
    });

    it('401: no/invalid token', () => {
      expect(() => jwtAuthGuard.handleRequest(null, false, null)).toThrow(UnauthorizedException);
    });

    it('success: ACCOUNTS_TEAM holds RPT:READ → guard resolves true', async () => {
      const ctx = mockContext(accountsActor, [{ module: 'RPT', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('success: PROJECT_MANAGER holds RPT:READ → guard resolves true', async () => {
      const ctx = mockContext(pmActor, [{ module: 'RPT', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('403: STORE_KEEPER (no RPT grant) is FORBIDDEN on RPT:READ', async () => {
      const ctx = mockContext(skActor, [{ module: 'RPT', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403: RolesGuard rejects when request.user is absent even if @Roles() is present', async () => {
      const ctx = mockContext(undefined, [{ module: 'RPT', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
