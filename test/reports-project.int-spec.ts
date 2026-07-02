/**
 * RPT project-reports integration — Testcontainers Postgres, real LED/MAS/SAL/CC/REC migrations. Seeds a
 * company + typed CoA (incl. labour '5110' + salary '6100') + FY + period + cost centres + a project budget
 * + two projects, then posted journal entries, a POSTED IPC + a partial receipt + a receipt REVERSAL, and
 * drives the real RPT read path (LedgerReadAdapter + SalesReadAdapter + CostControlReadAdapter +
 * ReportQueryService + ReportScopeService). Proves the brief's DoD:
 *   - project-pnl profit = revenue − cost AND ties to CC's project profitability (FR-RPT-015; CC FR-CC-009);
 *   - labour-cost = Σ(debit − credit) on labour EXPENSE accounts by cost centre (FR-RPT-019);
 *   - ipc-billing renders SAL's per-IPC outstanding/retention verbatim + an ageing bucket (FR-RPT-016/-017);
 *   - outstanding rolls up per project = Σ IPC outstanding; reversing a receipt raises it on the NEXT run
 *     with no stored state (FR-RPT-020; SRS edge 12);
 *   - cost-centre-variance ties byte-for-byte to CC's budget-vs-actual, incl. an UNBUDGETED pair (FR-RPT-025);
 *   - PM scope: assigned-only rows; an explicit unassigned projectId → 403 (FR-RPT-006/-007).
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
import { LedgerReadAdapter } from '../src/reports/infrastructure/ledger.read.adapter';
import { InventoryReadAdapter } from '../src/reports/infrastructure/inventory.read.adapter';
import { RequisitionReadAdapter } from '../src/reports/infrastructure/requisition.read.adapter';
import { HrReadAdapter } from '../src/reports/infrastructure/hr.read.adapter';
import { SalesReadAdapter } from '../src/reports/infrastructure/sales.read.adapter';
import { CostControlReadAdapter } from '../src/reports/infrastructure/cost-control.read.adapter';
import { ReportQueryService } from '../src/reports/application/report-query.service';
import { ReportScopeService } from '../src/reports/application/report-scope.service';
import { CostControlQueryService } from '../src/core/cost-control/application/cost-control-query.service';
import { TypeOrmCostControlReadRepository } from '../src/core/cost-control/infrastructure/typeorm-cost-control.read.repo';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c1';
const FY1 = '00000000-0000-0000-0000-0000000000f2';
const PERIOD = '00000000-0000-0000-0000-0000000000e2';
const USER = '00000000-0000-0000-0000-0000000000a2';
const CUSTOMER = '00000000-0000-0000-0000-00000000d201';
const P = '00000000-0000-0000-0000-00000000d301'; // project P (assigned)
const Q = '00000000-0000-0000-0000-00000000d302'; // project Q (unassigned)
const CC1 = '00000000-0000-0000-0000-0000000cc001'; // cost centre 1 (budgeted)
const CC2 = '00000000-0000-0000-0000-0000000cc002'; // cost centre 2 (unbudgeted)
const PURP = '00000000-0000-0000-0000-0000000dd001'; // purpose (for the IPC)
const IPC = '00000000-0000-0000-0000-0000000ec001'; // sales_invoice / IPC
const RECEIPT = '00000000-0000-0000-0000-0000000fc001'; // receipt

const GRP = {
  asset: '00000000-0000-0000-0000-0000000000b1',
  liability: '00000000-0000-0000-0000-0000000000b2',
  equity: '00000000-0000-0000-0000-0000000000b3',
  income: '00000000-0000-0000-0000-0000000000b4',
  expense: '00000000-0000-0000-0000-0000000000b5',
};
const ACC = {
  cash: '00000000-0000-0000-0000-00000000a110',
  bank: '00000000-0000-0000-0000-00000000a111',
  ar: '00000000-0000-0000-0000-00000000a120',
  capital: '00000000-0000-0000-0000-00000000a310',
  revenue: '00000000-0000-0000-0000-00000000a410',
  expense: '00000000-0000-0000-0000-00000000a510', // 5100 EXPENSE
  labour: '00000000-0000-0000-0000-00000000a511', // 5110 Labour Expense
  salary: '00000000-0000-0000-0000-00000000a610', // 6100 Salary Expense
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
  costCentre?: string | null;
  debit?: string;
  credit?: string;
}

describe('RPT project reports (real Postgres, real LED/SAL/CC/REC)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let query: ReportQueryService;
  let cc: CostControlQueryService;
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
          `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, debit, credit)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
          [entryId, lineNo, l.account, l.project ?? null, l.costCentre ?? null, l.debit ?? '0', l.credit ?? '0'],
        );
      }
    });
    return entryId;
  }

  async function reverseEntry(ofEntryId: string, date: string, lines: Line[]): Promise<string> {
    entrySeq += 1;
    const entryId = `00000000-0000-0000-0000-0000000f${String(entrySeq).padStart(4, '0')}`;
    await ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, is_reversal, reversal_of, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,'RECEIPT',$5,'GeneralVoucher',$1,true,$6,now(),$7)`,
        [entryId, CO, FY1, `GV/2526/${String(entrySeq).padStart(4, '0')}`, date, ofEntryId, USER],
      );
      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        await m.query(
          `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, debit, credit)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
          [entryId, lineNo, l.account, l.project ?? null, l.costCentre ?? null, l.debit ?? '0', l.credit ?? '0'],
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
      ds.query(`INSERT INTO account_group (id, company_id, name, parent_group_id, type) VALUES ($1,$2,$3,NULL,$4)`, [id, CO, name, type]);
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
    await acc(ACC.capital, '3100', 'Share Capital', GRP.equity, 'EQUITY');
    await acc(ACC.revenue, '4100', 'Contract Revenue', GRP.income, 'INCOME');
    await acc(ACC.expense, '5100', 'Site Expense', GRP.expense, 'EXPENSE');
    await acc(ACC.labour, '5110', 'Labour Expense', GRP.expense, 'EXPENSE');
    await acc(ACC.salary, '6100', 'Salary Expense', GRP.expense, 'EXPENSE');

    const costCentre = (id: string, code: string, name: string) =>
      ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,$3,$4)`, [id, CO, code, name]);
    await costCentre(CC1, 'CC-01', 'Civil');
    await costCentre(CC2, 'CC-02', 'Labour');

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
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'General')`, [PURP, CO, P]);

    // Project budget: (P, CC1) budgeted 5000 → OK/APPROACHING; (P, CC2) has NO budget → UNBUDGETED.
    await ds.query(
      `INSERT INTO project_budget (id, company_id, project_id, cost_centre_id, budgeted_amount) VALUES (gen_random_uuid(),$1,$2,$3,'5000.0000')`,
      [CO, P, CC1],
    );

    // ── Postings (balanced) ──
    await postEntry('CONTRA', '2026-06-01', [
      { account: ACC.bank, debit: '20000' },
      { account: ACC.capital, credit: '20000' },
    ]);
    // P&L on project P: revenue 4000 (INCOME), site expense 3200 (EXPENSE) — both on (P, CC1).
    await postEntry('SALES', '2026-06-10', [
      { account: ACC.ar, project: P, costCentre: CC1, debit: '4000' },
      { account: ACC.revenue, project: P, costCentre: CC1, credit: '4000' },
    ]);
    await postEntry('GENERAL', '2026-06-11', [
      { account: ACC.expense, project: P, costCentre: CC1, debit: '3200' },
      { account: ACC.bank, project: P, costCentre: CC1, credit: '3200' },
    ]);
    // Labour cost: labour 1000 on (P, CC2), salary 500 on (P, CC1).
    await postEntry('GENERAL', '2026-06-12', [
      { account: ACC.labour, project: P, costCentre: CC2, debit: '1000' },
      { account: ACC.salary, project: P, costCentre: CC1, debit: '500' },
      { account: ACC.bank, project: P, costCentre: CC1, credit: '1500' },
    ]);
    // Project Q (unassigned): revenue 1000 — must be excluded from a PM's P report.
    await postEntry('SALES', '2026-06-13', [
      { account: ACC.ar, project: Q, costCentre: CC1, debit: '1000' },
      { account: ACC.revenue, project: Q, costCentre: CC1, credit: '1000' },
    ]);

    // ── IPC (SAL) + partial receipt (REC) ──
    // certified 1375000; currently_due 1237500; retention 137500; vat 82500; advance 0.
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
    // Receipt of 1,000,000 against the IPC, POSTED with a real (non-reversed) journal entry so the
    // receipt_allocation view includes it.
    const receiptJe = await postEntry('RECEIPT', '2026-06-20', [
      { account: ACC.bank, project: P, costCentre: CC1, debit: '1000000' },
      { account: ACC.ar, project: P, costCentre: CC1, credit: '1000000' },
    ]);
    await ds.query(
      `INSERT INTO receipt
         (id, company_id, financial_year_id, receipt_type, receipt_date, payment_mode, deposit_account_id,
          party_id, project_id, cost_centre_id, ipc_id, amount_settled, cash_received, tax_deducted_at_source,
          status, entry_no, journal_entry_id, posted_at, posted_by)
       VALUES ($1,$2,$3,'IPC_LINKED','2026-06-20','CASH',$4,$5,$6,$7,$8,'1000000.0000','1000000.0000','0.0000',
               'POSTED','RCPT-0001',$9,now(),$10)`,
      [RECEIPT, CO, FY1, ACC.bank, CUSTOMER, P, CC1, IPC, receiptJe, USER],
    );
    // Keep the receipt JE id for the reversal test.
    (globalThis as Record<string, unknown>).__receiptJe = receiptJe;

    query = new ReportQueryService(
      new LedgerReadAdapter(ds),
      new InventoryReadAdapter(ds),
      new RequisitionReadAdapter(ds),
      new HrReadAdapter(ds),
      new ReportScopeService(),
      new SalesReadAdapter(ds),
      new CostControlReadAdapter(ds),
    );
    cc = new CostControlQueryService(new TypeOrmCostControlReadRepository(ds));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  // ── project P&L (FR-RPT-015) ──
  it('project-pnl: profit = revenue − cost, per-cost-centre breakdown + a project total; ties to CC profitability', async () => {
    const rpt = await query.projectPnl({ financialYearId: FY1, projectId: P }, admin);
    // revenue 4000; cost = 3200 (site) + 1000 (labour) + 500 (salary) = 4700; profit = -700.
    expect(rpt.totals).toEqual({ revenue: '4000.0000', cost: '4700.0000', profit: '-700.0000' });
    const total = rpt.rows.find((r) => r.costCentreId === null);
    expect(total).toEqual({ projectId: P, costCentreId: null, revenue: '4000.0000', cost: '4700.0000', profit: '-700.0000' });
    // per-cost-centre rows carry the project + a non-null cost centre.
    const perCc = rpt.rows.filter((r) => r.costCentreId !== null);
    expect(perCc.length).toBeGreaterThan(0);
    expect(perCc.every((r) => r.projectId === P)).toBe(true);

    // Ties to CC's canonical project profitability for the same params (FR-CC-009).
    const ccProfit = await cc.profitability({ financialYearId: FY1, projectId: P, groupBy: 'project' }, admin);
    const ccRow = ccProfit.items[0];
    expect({ revenue: ccRow.revenue, cost: ccRow.cost, profit: ccRow.profit }).toEqual(rpt.totals);
  });

  // ── labour cost (FR-RPT-019) ──
  it('labour-cost: Σ(debit − credit) on labour EXPENSE accounts grouped by cost centre (FR-RPT-019)', async () => {
    const rpt = await query.labourCost({ financialYearId: FY1, projectId: P }, admin);
    // labour 1000 (CC2) + salary 500 (CC1) = 1500 (site expense 5100 is NOT a labour account).
    expect(rpt.totals).toEqual({ labourCost: '1500.0000' });
    const byCc = Object.fromEntries(rpt.rows.map((r) => [r.costCentreId, r.labourCost]));
    expect(byCc[CC1]).toBe('500.0000');
    expect(byCc[CC2]).toBe('1000.0000');
  });

  // ── IPC billing (FR-RPT-016/-017) ──
  it('ipc-billing: renders SAL per-IPC outstanding/retention verbatim + an ageing bucket (FR-RPT-016/-017)', async () => {
    const rpt = await query.ipcBilling({ financialYearId: FY1, projectId: P }, admin);
    expect(rpt.rows).toHaveLength(1);
    const row = rpt.rows[0];
    expect(row.certifiedAmount).toBe('1375000.0000');
    expect(row.billedAmount).toBe('1457500.0000'); // 1237500 + 137500 + 0 + 82500
    expect(row.receivedAmount).toBe('1000000.0000');
    expect(row.outstandingAmount).toBe('237500.0000'); // 1237500 − 1000000 (SAL's formula)
    expect(row.retentionHeld).toBe('137500.0000');
    expect(['CURRENT', 'D31_60', 'D61_90', 'D90_PLUS']).toContain(row.ageingBucket);
    expect(rpt.totals).toEqual({
      certified: '1375000.0000', billed: '1457500.0000', received: '1000000.0000',
      outstanding: '237500.0000', retentionHeld: '137500.0000',
    });
  });

  // ── outstanding (FR-RPT-020) + receipt reversal (SRS edge 12) ──
  it('outstanding: project total = Σ IPC outstanding; reversing the receipt raises it on the NEXT run', async () => {
    const before = await query.outstanding({ financialYearId: FY1, projectId: P, asOf: '2026-07-15' }, admin);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0].outstandingAmount).toBe('237500.0000');
    expect(before.totals).toEqual({ [P]: '237500.0000', outstanding: '237500.0000' });
    // due 2026-06-30, asOf 2026-07-15 → 15 days overdue → CURRENT.
    expect(before.rows[0].ageingBucket).toBe('CURRENT');

    // Reverse the receipt: a journal entry with reversal_of = the receipt's JE drops it from the
    // receipt_allocation view (no stored state) → outstanding rises back to the full currently-due.
    const receiptJe = (globalThis as Record<string, unknown>).__receiptJe as string;
    await reverseEntry(receiptJe, '2026-06-21', [
      { account: ACC.ar, project: P, costCentre: CC1, debit: '1000000' },
      { account: ACC.bank, project: P, costCentre: CC1, credit: '1000000' },
    ]);

    const after = await query.outstanding({ financialYearId: FY1, projectId: P, asOf: '2026-07-15' }, admin);
    expect(after.rows[0].receivedAmount).toBe('0.0000');
    expect(after.rows[0].outstandingAmount).toBe('1237500.0000'); // rose again, live query
    expect(after.totals).toEqual({ [P]: '1237500.0000', outstanding: '1237500.0000' });
  });

  // ── cost-centre variance (FR-RPT-025) ──
  it('cost-centre-variance: ties byte-for-byte to CC budget-vs-actual, incl. an UNBUDGETED pair (FR-RPT-025)', async () => {
    const rpt = await query.costCentreVariance({ financialYearId: FY1, projectId: P }, admin);
    const ccRows = (await cc.budgetVsActual({ financialYearId: FY1, projectId: P }, admin)).items;
    expect(rpt.rows).toEqual(ccRows); // single source of truth — identical

    const byCc = Object.fromEntries(rpt.rows.map((r) => [r.costCentreId, r]));
    // (P, CC1): actual = 3200 (site) + 500 (salary) = 3700; budget 5000 → OK, variance 1300, util 74%.
    expect(byCc[CC1].actualCost).toBe('3700.0000');
    expect(byCc[CC1].budgetedAmount).toBe('5000.0000');
    expect(byCc[CC1].variance).toBe('1300.0000');
    expect(byCc[CC1].status).toBe('OK');
    // (P, CC2): actual 1000, no budget → UNBUDGETED with null budget/variance/utilisation.
    expect(byCc[CC2].status).toBe('UNBUDGETED');
    expect(byCc[CC2].budgetedAmount).toBeNull();
    expect(byCc[CC2].variance).toBeNull();
    expect(byCc[CC2].utilisationPct).toBeNull();
  });

  it('cost-centre-variance: a status csv filters rows (UNBUDGETED only)', async () => {
    const rpt = await query.costCentreVariance({ financialYearId: FY1, projectId: P, status: 'UNBUDGETED' }, admin);
    expect(rpt.rows.every((r) => r.status === 'UNBUDGETED')).toBe(true);
    expect(rpt.rows.find((r) => r.costCentreId === CC2)).toBeDefined();
  });

  // ── material consumption vs budget (FR-RPT-018) ──
  it('material-consumption-vs-budget: consumes the same CC budget-vs-actual metric', async () => {
    const rpt = await query.materialConsumptionVsBudget({ financialYearId: FY1, projectId: P }, admin);
    const ccRows = (await cc.budgetVsActual({ financialYearId: FY1, projectId: P }, admin)).items;
    expect(rpt.rows).toEqual(ccRows);
  });

  // ── PM scope (FR-RPT-006/-007) ──
  it('scope: a PM sees only assigned-project rows; an explicit unassigned projectId is 403', async () => {
    // PM assigned to P → project-pnl for P works and excludes Q's revenue.
    const pmPnl = await query.projectPnl({ financialYearId: FY1, projectId: P }, pmP);
    expect(pmPnl.totals!.revenue).toBe('4000.0000');

    // Explicit unassigned project Q → 403 across the project reports.
    await expect(query.projectPnl({ financialYearId: FY1, projectId: Q }, pmP)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(query.ipcBilling({ financialYearId: FY1, projectId: Q }, pmP)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(query.costCentreVariance({ financialYearId: FY1, projectId: Q }, pmP)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scope: a PM with no explicit projectId is auto-filtered to assigned projects (ipc-billing)', async () => {
    const rpt = await query.ipcBilling({ financialYearId: FY1 }, pmP);
    // Only project P has an IPC and P is assigned → the one IPC is visible.
    expect(rpt.rows).toHaveLength(1);
    expect(rpt.rows[0].projectId).toBe(P);
  });
});
