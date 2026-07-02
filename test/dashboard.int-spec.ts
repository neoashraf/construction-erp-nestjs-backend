/**
 * DSH dashboard integration — Testcontainers Postgres, real LED/MAS/SAL/CC/INV/HR migrations. Reuses the
 * reports-project.int-spec bootstrap and seeds the read models each tile summarises: cash/bank + AR/AP-by-
 * party journal lines, a POSTED IPC + partial receipt, a project budget + an over-budget expense, stock
 * balances below re-order, and a month's attendance. Drives the REAL DSH read path (DashboardService +
 * TileQueryService + DashboardScopeService reusing RPT's read ports + a DSH ledger adapter) and proves the
 * brief's DoD:
 *   - pending-ipcs.totalOutstanding == ipc-billing outstanding total for the same scope (FR-DSH-004/-012);
 *   - retention-held == ipc-billing retention total (FR-DSH-013);
 *   - over-budget.overCount == cost-centre-variance OVER count (FR-DSH-015); reversing the expense drops it
 *     on the NEXT read with no stored tile (FR-DSH edge 6 / AC10);
 *   - low-stock.count == low-stock report row count, status BREACH (FR-DSH-014);
 *   - attendance totals == attendance-summary report totals (FR-DSH-016);
 *   - cash-flow ties to the ledger's cash/bank lines (FR-DSH-011); top receivables/payables tie to the
 *     AR/AP control balance by party, ordered by outstanding, Bangla names un-truncated (FR-DSH-017);
 *   - role-scoped assembly returns the right tile set; single-tile 404/403 (FR-DSH-005/-007/-010);
 *   - loading the dashboard + every tile writes NO journal row (FR-DSH-003 / AC8).
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ForbiddenException } from '@nestjs/common';

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
import { LedgerReadAdapter as RptLedgerReadAdapter } from '../src/reports/infrastructure/ledger.read.adapter';
import { InventoryReadAdapter } from '../src/reports/infrastructure/inventory.read.adapter';
import { RequisitionReadAdapter } from '../src/reports/infrastructure/requisition.read.adapter';
import { HrReadAdapter } from '../src/reports/infrastructure/hr.read.adapter';
import { SalesReadAdapter } from '../src/reports/infrastructure/sales.read.adapter';
import { CostControlReadAdapter } from '../src/reports/infrastructure/cost-control.read.adapter';
import { ReportQueryService } from '../src/reports/application/report-query.service';
import { ReportScopeService } from '../src/reports/application/report-scope.service';

import { LedgerReadAdapter as DshLedgerReadAdapter } from '../src/dashboard/infrastructure/ledger.read.adapter';
import { DashboardService } from '../src/dashboard/application/dashboard.service';
import { DashboardScopeService } from '../src/dashboard/application/dashboard-scope.service';
import { TileQueryService } from '../src/dashboard/application/tile-query.service';
import { UnknownTileError, TileNotPermittedError } from '../src/dashboard/domain/errors';
import {
  AttendanceKpi,
  CashFlowKpi,
  LowStockKpi,
  OverBudgetKpi,
  PendingIpcKpi,
  RetentionHeldKpi,
  TopReceivablePayableKpi,
} from '../src/dashboard/domain/tile.model';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c1';
const FY1 = '00000000-0000-0000-0000-0000000000f2';
const PERIOD = '00000000-0000-0000-0000-0000000000e2';
const USER = '00000000-0000-0000-0000-0000000000a2';
const CUSTOMER = '00000000-0000-0000-0000-00000000d201'; // Bangla name, big AR
const CUSTOMER2 = '00000000-0000-0000-0000-00000000d202'; // smaller AR
const SUPPLIER = '00000000-0000-0000-0000-00000000d203'; // AP
const P = '00000000-0000-0000-0000-00000000d301'; // assigned
const Q = '00000000-0000-0000-0000-00000000d302'; // unassigned
const CC1 = '00000000-0000-0000-0000-0000000cc001'; // budgeted
const CC2 = '00000000-0000-0000-0000-0000000cc002'; // unbudgeted
const PURP = '00000000-0000-0000-0000-0000000dd001';
const GODOWN = '00000000-0000-0000-0000-0000000d9001';
const ITEM1 = '00000000-0000-0000-0000-0000000d7001';
const ITEM2 = '00000000-0000-0000-0000-0000000d7002';
const ITEM3 = '00000000-0000-0000-0000-0000000d7003';
const EMP = '00000000-0000-0000-0000-0000000d5001';
const IPC = '00000000-0000-0000-0000-0000000ec001';
const RECEIPT = '00000000-0000-0000-0000-0000000fc001';

const GRP = {
  asset: '00000000-0000-0000-0000-0000000000b1',
  liability: '00000000-0000-0000-0000-0000000000b2',
  equity: '00000000-0000-0000-0000-0000000000b3',
  income: '00000000-0000-0000-0000-0000000000b4',
  expense: '00000000-0000-0000-0000-0000000000b5',
};
const ACC = {
  cash: '00000000-0000-0000-0000-00000000a110', // 1100
  bank: '00000000-0000-0000-0000-00000000a111', // 1110
  ar: '00000000-0000-0000-0000-00000000a120', // 1200
  ap: '00000000-0000-0000-0000-00000000a210', // 2100
  capital: '00000000-0000-0000-0000-00000000a310', // 3100
  revenue: '00000000-0000-0000-0000-00000000a410', // 4100
  expense: '00000000-0000-0000-0000-00000000a510', // 5100 EXPENSE
};

const accounts: Actor = {
  userId: USER, companyId: CO, financialYearId: FY1, role: 'ACCOUNTS_TEAM',
  isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pmP: Actor = {
  userId: 'pm-user', companyId: CO, financialYearId: FY1, role: 'PROJECT_MANAGER',
  isUnscoped: false, assignedProjectIds: [P], approvalLimit: null,
};
const hrMgr: Actor = {
  userId: 'hr-user', companyId: CO, financialYearId: FY1, role: 'HR_MANAGER',
  isUnscoped: false, assignedProjectIds: [P], approvalLimit: null,
};
const store: Actor = {
  userId: 'sk-user', companyId: CO, financialYearId: FY1, role: 'STORE_KEEPER',
  isUnscoped: false, assignedProjectIds: [P], approvalLimit: null,
};

interface Line {
  account: string;
  project?: string | null;
  costCentre?: string | null;
  party?: string | null;
  debit?: string;
  credit?: string;
}

describe('DSH dashboard (real Postgres, real LED/SAL/CC/INV/HR + reused RPT read ports)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let dashboard: DashboardService;
  let rpt: ReportQueryService;
  let entrySeq = 0;

  async function postEntry(
    voucherType: string,
    date: string,
    lines: Line[],
    opts: { reversalOf?: string } = {},
  ): Promise<string> {
    entrySeq += 1;
    const entryId = `00000000-0000-0000-0000-0000000f${String(entrySeq).padStart(4, '0')}`;
    await ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, is_reversal, reversal_of, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,$5,$6,'GeneralVoucher',$1,$7,$8,now(),$9)`,
        [
          entryId, CO, FY1, `GV/2526/${String(entrySeq).padStart(4, '0')}`, voucherType, date,
          opts.reversalOf ? true : false, opts.reversalOf ?? null, USER,
        ],
      );
      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        await m.query(
          `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, party_id, debit, credit)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8)`,
          [entryId, lineNo, l.account, l.project ?? null, l.costCentre ?? null, l.party ?? null, l.debit ?? '0', l.credit ?? '0'],
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
        CompanyOrmEntity, FinancialYearOrmEntity, NumberingSeriesOrmEntity, AccountingPeriodOrmEntity,
        JournalEntryOrmEntity, JournalLineOrmEntity, AccountOrmEntity, PartyOrmEntity, ProjectOrmEntity,
        RoleOrmEntity, PermissionOrmEntity,
      ],
      migrations: [
        InitialBaseline1700000000000, CreateCompanyFinancialYear1700000100000, CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000, CreateLedger1700000400000, CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000, CreateUser1700000700000, CreateRbacAndAudit1700000800000,
        AddExportActionToAuditLog1700000900000, CreateStockMovementAndBalance1700001000000, CreateContraJournal1700001100000,
        CreateSalesInvoice1700001200000, CreateHrEmployeeAttendance1700001300000, CreateRequisition1700001400000,
        CreateStockJournal1700001500000, CreateReceipt1700001600000, CreateRetentionRelease1700001700000,
        CreateHrSalary1700001800000, CreateRequisitionIssue1700001900000, CreatePurchasePoBill1700002000000,
        CreatePurchaseGrn1700002100000, CreatePayment1700002200000,
      ],
    });
    await ds.initialize();
    await ds.runMigrations();

    await ds.query(`INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`, [CO]);
    await ds.query(`INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`, [FY1, CO]);
    await ds.query(`INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES ($1,$2,$3,'Jun 2026','2026-06-01','2026-06-30','OPEN')`, [PERIOD, CO, FY1]);

    const grp = (id: string, name: string, type: string) =>
      ds.query(`INSERT INTO account_group (id, company_id, name, parent_group_id, type) VALUES ($1,$2,$3,NULL,$4)`, [id, CO, name, type]);
    await grp(GRP.asset, 'Assets', 'ASSET');
    await grp(GRP.liability, 'Liabilities', 'LIABILITY');
    await grp(GRP.equity, 'Equity', 'EQUITY');
    await grp(GRP.income, 'Income', 'INCOME');
    await grp(GRP.expense, 'Expenses', 'EXPENSE');

    const acc = (id: string, code: string, name: string, group: string, type: string) =>
      ds.query(`INSERT INTO account (id, company_id, code, name, account_group_id, type, opening_balance) VALUES ($1,$2,$3,$4,$5,$6,NULL)`, [id, CO, code, name, group, type]);
    await acc(ACC.cash, '1100', 'Cash in Hand', GRP.asset, 'ASSET');
    await acc(ACC.bank, '1110', 'Bank — Operating', GRP.asset, 'ASSET');
    await acc(ACC.ar, '1200', 'Accounts Receivable', GRP.asset, 'ASSET');
    await acc(ACC.ap, '2100', 'Accounts Payable', GRP.liability, 'LIABILITY');
    await acc(ACC.capital, '3100', 'Share Capital', GRP.equity, 'EQUITY');
    await acc(ACC.revenue, '4100', 'Contract Revenue', GRP.income, 'INCOME');
    await acc(ACC.expense, '5100', 'Site Expense', GRP.expense, 'EXPENSE');

    const costCentre = (id: string, code: string, name: string) =>
      ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,$3,$4)`, [id, CO, code, name]);
    await costCentre(CC1, 'CC-01', 'Civil');
    await costCentre(CC2, 'CC-02', 'Labour');

    const party = (id: string, name: string, isCustomer: boolean, isSupplier: boolean) =>
      ds.query(`INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,$3,$4,$5,'+8801700000000')`, [id, CO, name, isCustomer, isSupplier]);
    await party(CUSTOMER, 'জনতা বিল্ডার্স', true, false);
    await party(CUSTOMER2, 'Meghna Traders', true, false);
    await party(SUPPLIER, 'Padma Cement Ltd', false, true);

    const proj = (id: string, code: string, name: string) =>
      ds.query(`INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,$3,$4,$5,$6,'2025-07-01','2026-06-30','ACTIVE')`, [id, CO, code, name, CUSTOMER, USER]);
    await proj(P, 'P-01', 'Site P');
    await proj(Q, 'P-02', 'Site Q');
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'General')`, [PURP, CO, P]);
    await ds.query(`INSERT INTO godown (id, company_id, project_id, name) VALUES ($1,$2,$3,'Main Store')`, [GODOWN, CO, P]);

    const item = (id: string, code: string, name: string) =>
      ds.query(`INSERT INTO item (id, company_id, code, name, base_uom, default_account_id) VALUES ($1,$2,$3,$4,'PCS',$5)`, [id, CO, code, name, ACC.expense]);
    await item(ITEM1, 'IT-01', 'Cement');
    await item(ITEM2, 'IT-02', 'Rebar');
    await item(ITEM3, 'IT-03', 'Sand');
    await ds.query(`INSERT INTO employee (id, company_id, employee_code, name, designation, work_base, wage_type, wage_amount, joining_date) VALUES ($1,$2,'E-01','Karim','Engineer','SITE','MONTHLY',60000,'2025-07-01')`, [EMP, CO]);

    // Project budget: (P, CC1) = 5000.
    await ds.query(`INSERT INTO project_budget (id, company_id, project_id, cost_centre_id, budgeted_amount) VALUES (gen_random_uuid(),$1,$2,$3,'5000.0000')`, [CO, P, CC1]);

    // ── Cash/bank movement ──
    await postEntry('CONTRA', '2026-06-01', [
      { account: ACC.bank, debit: '20000' },
      { account: ACC.capital, credit: '20000' },
    ]);
    await postEntry('CONTRA', '2026-06-02', [
      { account: ACC.cash, debit: '8000' },
      { account: ACC.bank, credit: '8000' },
    ]);
    // Over-budget expense on (P, CC1): 6000 > budget 5000 → OVER. Paid from bank (bank −6000).
    const overBudgetEntry = await postEntry('GENERAL', '2026-06-11', [
      { account: ACC.expense, project: P, costCentre: CC1, debit: '6000' },
      { account: ACC.bank, project: P, credit: '6000' },
    ]);
    (globalThis as Record<string, unknown>).__overBudgetEntry = overBudgetEntry;

    // ── AR by party (receivables) ──
    await postEntry('SALES', '2026-06-05', [
      { account: ACC.ar, party: CUSTOMER, project: P, debit: '9000' },
      { account: ACC.revenue, project: P, credit: '9000' },
    ]);
    await postEntry('SALES', '2026-06-06', [
      { account: ACC.ar, party: CUSTOMER2, project: P, debit: '2000' },
      { account: ACC.revenue, project: P, credit: '2000' },
    ]);
    // ── AP by party (payables) — untagged project/cost-centre so it does not affect CC ──
    await postEntry('PURCHASE', '2026-06-07', [
      { account: ACC.expense, debit: '4000' },
      { account: ACC.ap, party: SUPPLIER, credit: '4000' },
    ]);

    // ── IPC (SAL) + partial receipt (REC) ──
    await ds.query(
      `INSERT INTO sales_invoice
         (id, company_id, financial_year_id, project_id, customer_id, ipc_seq_no, ipc_date, bill_date, due_date,
          work_completed_pct, certified_amount, cost_centre_id, purpose_id, output_vat_amount, ait_tds_amount,
          retention_amount, advance_recovered_amount, currently_due_amount, retention_rate_pct, advance_rate_pct,
          status, entry_no, journal_entry_id, posted_at, posted_by)
       VALUES ($1,$2,$3,$4,$5,1,'2026-05-31','2026-05-31','2026-06-30',
               '50.0000','1375000.0000',$6,$7,'82500.0000','0.0000',
               '137500.0000','0.0000','1237500.0000','10.0000','0.0000',
               'POSTED','IPC-2026-000007',NULL,now(),$8)`,
      [IPC, CO, FY1, P, CUSTOMER, CC1, PURP, USER],
    );
    const receiptJe = await postEntry('RECEIPT', '2026-06-20', [
      { account: ACC.cash, project: P, debit: '1000000' },
      { account: ACC.ar, party: CUSTOMER, project: P, credit: '1000000' },
    ]);
    await ds.query(
      `INSERT INTO receipt
         (id, company_id, financial_year_id, receipt_type, receipt_date, payment_mode, deposit_account_id,
          party_id, project_id, cost_centre_id, ipc_id, amount_settled, cash_received, tax_deducted_at_source,
          status, entry_no, journal_entry_id, posted_at, posted_by)
       VALUES ($1,$2,$3,'IPC_LINKED','2026-06-20','CASH',$4,$5,$6,$7,$8,'1000000.0000','1000000.0000','0.0000',
               'POSTED','RCPT-0001',$9,now(),$10)`,
      [RECEIPT, CO, FY1, ACC.cash, CUSTOMER, P, CC1, IPC, receiptJe, USER],
    );

    // ── INV: stock balances below re-order (threshold 10 → ITEM2 qty 5, ITEM3 qty 2 are low) ──
    const bal = (id: string, item: string, qty: string, value: string, rate: string) =>
      ds.query(`INSERT INTO stock_balance (id, company_id, godown_id, item_id, quantity_on_hand, total_value, avg_rate) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, CO, GODOWN, item, qty, value, rate]);
    await bal('00000000-0000-0000-0000-0000000db101', ITEM1, '150', '75000', '500');
    await bal('00000000-0000-0000-0000-0000000db102', ITEM2, '5', '250', '50');
    await bal('00000000-0000-0000-0000-0000000db103', ITEM3, '2', '100', '50');

    // ── HR attendance: Jun-2026 (office employee) ──
    const att = (id: string, date: string, status: string) =>
      ds.query(`INSERT INTO attendance_record (id, company_id, financial_year_id, mode, attendance_date, project_id, employee_id, day_status) VALUES ($1,$2,$3,'OFFICE',$4,$5,$6,$7)`, [id, CO, FY1, date, P, EMP, status]);
    await att('00000000-0000-0000-0000-0000000da101', '2026-06-01', 'PRESENT');
    await att('00000000-0000-0000-0000-0000000da102', '2026-06-02', 'PRESENT');
    await att('00000000-0000-0000-0000-0000000da103', '2026-06-03', 'PRESENT');
    await att('00000000-0000-0000-0000-0000000da104', '2026-06-04', 'ABSENT');

    rpt = new ReportQueryService(
      new RptLedgerReadAdapter(ds),
      new InventoryReadAdapter(ds),
      new RequisitionReadAdapter(ds),
      new HrReadAdapter(ds),
      new ReportScopeService(),
      new SalesReadAdapter(ds),
      new CostControlReadAdapter(ds),
    );
    // DSH reuses RPT's CC/SAL/INV/HR adapters + a DSH ledger adapter.
    const tileQuery = new TileQueryService(
      new CostControlReadAdapter(ds),
      new SalesReadAdapter(ds),
      new InventoryReadAdapter(ds),
      new HrReadAdapter(ds),
      new DshLedgerReadAdapter(ds),
    );
    dashboard = new DashboardService(new DashboardScopeService(new ReportScopeService()), tileQuery);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  it('pending-ipcs.totalOutstanding ties to the ipc-billing report outstanding total (FR-DSH-004/-012)', async () => {
    const tile = await dashboard.tile('pending-ipcs', accounts, { financialYearId: FY1 });
    const kpi = tile.kpi as PendingIpcKpi;
    const report = await rpt.ipcBilling({ financialYearId: FY1 }, accounts);
    expect(kpi.totalOutstanding).toBe(report.totals!.outstanding);
    expect(kpi.totalOutstanding).toBe('237500.0000');
    expect(kpi.count).toBe(1);
    expect(tile.drillTo.report).toBe('ipc-billing');
  });

  it('retention-held ties to the ipc-billing report retention total (FR-DSH-013)', async () => {
    const tile = await dashboard.tile('retention-held', accounts, { financialYearId: FY1 });
    const report = await rpt.ipcBilling({ financialYearId: FY1 }, accounts);
    expect((tile.kpi as RetentionHeldKpi).totalRetentionHeld).toBe(report.totals!.retentionHeld);
    expect((tile.kpi as RetentionHeldKpi).totalRetentionHeld).toBe('137500.0000');
  });

  it('over-budget.overCount ties to the cost-centre-variance OVER count; status OVER (FR-DSH-015/-018)', async () => {
    const tile = await dashboard.tile('over-budget', accounts, { financialYearId: FY1 });
    const kpi = tile.kpi as OverBudgetKpi;
    const variance = await rpt.costCentreVariance({ financialYearId: FY1 }, accounts);
    const overRows = variance.rows.filter((r) => r.status === 'OVER').length;
    expect(kpi.overCount).toBe(overRows);
    expect(kpi.overCount).toBe(1);
    expect(tile.status).toBe('OVER');
    expect(tile.drillTo.params.status).toBe('OVER,APPROACHING');
  });

  it('low-stock.count ties to the low-stock report row count; status BREACH (FR-DSH-014)', async () => {
    const tile = await dashboard.tile('low-stock', store, { reorderLevel: '10' });
    const report = await rpt.lowStock({ reorderLevel: '10' }, store);
    expect((tile.kpi as LowStockKpi).count).toBe(report.rows.length);
    expect((tile.kpi as LowStockKpi).count).toBe(2);
    expect(tile.status).toBe('BREACH');
  });

  it('attendance totals tie to the attendance-summary report (FR-DSH-016)', async () => {
    const tile = await dashboard.tile('attendance-summary', hrMgr, { month: '2026-06' });
    const kpi = tile.kpi as AttendanceKpi;
    const report = await rpt.attendanceSummary({ month: '2026-06', pageSize: 200 }, hrMgr);
    const present = report.items.reduce((a, r) => a + r.daysPresent, 0);
    const heads = report.items.reduce((a, r) => a + r.headCountTotal, 0);
    expect(kpi.presentDays).toBe(present);
    expect(kpi.presentDays).toBe(3);
    expect(kpi.headCountTotal).toBe(`${heads}.0000`);
    expect(kpi.period).toBe('2026-06');
  });

  it('cash-flow ties to the ledger cash/bank lines (FR-DSH-011)', async () => {
    const tile = await dashboard.tile('project-cash-flow', accounts, { financialYearId: FY1 });
    const kpi = tile.kpi as CashFlowKpi;
    const bal = async (codes: string): Promise<string> => {
      const [row] = await ds.query(
        `SELECT COALESCE(SUM(l.debit - l.credit),0)::numeric(18,4)::text AS b
           FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id
           JOIN account a ON a.id = l.account_id
          WHERE e.company_id = $1 AND a.code IN (${codes})`,
        [CO],
      );
      return row.b as string;
    };
    expect(kpi.cashBalance).toBe(await bal("'1100'"));
    expect(kpi.bankBalance).toBe(await bal("'1110'"));
    expect(kpi.netInflow).toBe(await bal("'1100','1110'"));
    // cash: +8000 (contra) +1000000 (receipt) = 1008000; bank: 20000 −8000 −6000 = 6000.
    expect(kpi.cashBalance).toBe('1008000.0000');
    expect(kpi.bankBalance).toBe('6000.0000');
  });

  it('top receivables/payables tie to AR/AP control by party, ordered by outstanding, Bangla un-truncated (FR-DSH-017)', async () => {
    const tile = await dashboard.tile('top-receivables-payables', accounts, { financialYearId: FY1 });
    const kpi = tile.kpi as TopReceivablePayableKpi;
    // AR: CUSTOMER 9000 − 1000000 receipt = negative → excluded; CUSTOMER2 2000 remains. So top = CUSTOMER2.
    expect(kpi.topReceivables.map((r) => r.partyId)).toEqual([CUSTOMER2]);
    expect(kpi.topReceivables[0].outstanding).toBe('2000.0000');
    // AP: SUPPLIER 4000.
    expect(kpi.topPayables).toHaveLength(1);
    expect(kpi.topPayables[0].partyName).toBe('Padma Cement Ltd');
    expect(kpi.topPayables[0].outstanding).toBe('4000.0000');
  });

  it('top receivables orders parties by outstanding desc when multiple are positive', async () => {
    // Bump CUSTOMER's receivable back positive with a fresh receivable so ordering is exercised.
    await postEntry('SALES', '2026-06-08', [
      { account: ACC.ar, party: CUSTOMER, project: P, debit: '999999' },
      { account: ACC.revenue, project: P, credit: '999999' },
    ]);
    const tile = await dashboard.tile('top-receivables-payables', accounts, { financialYearId: FY1 });
    const kpi = tile.kpi as TopReceivablePayableKpi;
    // CUSTOMER now 9000 + 999999 − 1000000 = 8999 > CUSTOMER2 2000.
    expect(kpi.topReceivables.map((r) => r.partyId)).toEqual([CUSTOMER, CUSTOMER2]);
    expect(kpi.topReceivables[0].partyName).toBe('জনতা বিল্ডার্স');
  });

  it('role-scoped assembly returns the right tile set per role (FR-DSH-007/-010)', async () => {
    const keys = async (a: Actor) => (await dashboard.assemble(a, { financialYearId: FY1, month: '2026-06', reorderLevel: '10' })).map((t) => t.key).sort();
    expect(await keys(store)).toEqual(['low-stock']);
    expect(await keys(hrMgr)).toEqual(['attendance-summary']);
    expect(await keys(accounts)).toEqual(
      ['low-stock', 'over-budget', 'pending-ipcs', 'project-cash-flow', 'retention-held', 'top-receivables-payables'].sort(),
    );
    expect(await keys(pmP)).toEqual(['low-stock', 'over-budget', 'pending-ipcs', 'project-cash-flow', 'retention-held'].sort());
  });

  it('single tile: unknown key → 404 (UnknownTileError); a role-forbidden tile → 403 (TileNotPermittedError)', async () => {
    await expect(dashboard.tile('nope', accounts, {})).rejects.toBeInstanceOf(UnknownTileError);
    await expect(dashboard.tile('over-budget', store, {})).rejects.toBeInstanceOf(TileNotPermittedError);
  });

  it('project scope: a PM with an explicit unassigned projectId → 403 (FR-DSH-009)', async () => {
    await expect(dashboard.assemble(pmP, { financialYearId: FY1, projectId: Q })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('loading the dashboard + every tile writes NO journal row (FR-DSH-003 / AC8)', async () => {
    const count = async () => {
      const [e] = await ds.query('SELECT count(*)::text AS c FROM journal_entry');
      const [l] = await ds.query('SELECT count(*)::text AS c FROM journal_line');
      return { entries: e.c, lines: l.c };
    };
    const before = await count();
    await dashboard.assemble(accounts, { financialYearId: FY1, month: '2026-06', reorderLevel: '10' });
    for (const key of ['project-cash-flow', 'pending-ipcs', 'retention-held', 'over-budget', 'top-receivables-payables']) {
      await dashboard.tile(key, accounts, { financialYearId: FY1, reorderLevel: '10' });
    }
    await dashboard.tile('low-stock', store, { reorderLevel: '10' });
    await dashboard.tile('attendance-summary', hrMgr, { month: '2026-06' });
    expect(await count()).toEqual(before);
  });

  it('reversal drops the over-budget count on the next read, with no stored tile (AC10 / FR-DSH edge 6)', async () => {
    const before = await dashboard.tile('over-budget', accounts, { financialYearId: FY1 });
    expect((before.kpi as OverBudgetKpi).overCount).toBe(1);

    // Reverse the over-budget expense: (P, CC1) actual falls to 0 < budget → no longer OVER.
    const overBudgetEntry = (globalThis as Record<string, unknown>).__overBudgetEntry as string;
    await postEntry('GENERAL', '2026-06-12', [
      { account: ACC.expense, project: P, costCentre: CC1, credit: '6000' },
      { account: ACC.bank, project: P, debit: '6000' },
    ], { reversalOf: overBudgetEntry });

    const after = await dashboard.tile('over-budget', accounts, { financialYearId: FY1 });
    expect((after.kpi as OverBudgetKpi).overCount).toBe(0);
    expect(after.status).not.toBe('OVER');
  });
});
