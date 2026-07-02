/**
 * RPT inventory / requisition / HR integration (RPT #31 · FR-RPT-021…028) — Testcontainers Postgres, real
 * LED/MAS/INV/REQ/HR/PAY migrations. Mirrors reports-financial.int-spec.ts's bootstrap and seeds the
 * owning-module PROJECTIONS + the matching journal_entry/journal_line directly via SQL (the simplest way to
 * prove tie-out — the projection rows are what INV/HR own; RPT reads, never recomputes). Proves the brief's
 * DoD:
 *   - stock valuation totals tie to the inventory '1300' control-account balance (FR-RPT-021; INV FR-INV-005);
 *   - low-stock returns (godown,item) at/below the param threshold; missing threshold is a 400 (FR-RPT-022);
 *   - stock valuation as-of a date before any movement → rows:[] / value 0 (SRS edge 11);
 *   - stock-transfer summary lists posted Stock Journal transfers (FR-RPT-023);
 *   - requisition-vs-issue variance = requested − issued (FR-RPT-024);
 *   - salary register totals tie to the posted SALARY ledger entry (FR-RPT-027);
 *   - an empty month returns a valid empty attendance report (200, rows:[]) (SRS edge 4);
 *   - RBAC: a role WITHOUT HR:READ is 403 on salary-register; HR:READ → 200; INV:READ → 200 on stock-valuation.
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
import { ValidationError } from '../src/common/errors/domain-error';

// RolesGuard smoke deps.
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { PermissionRequirement } from '../src/core/auth/presentation/roles.decorator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c1';
const FY1 = '00000000-0000-0000-0000-0000000000f2';
const PERIOD = '00000000-0000-0000-0000-0000000000e2';
const USER = '00000000-0000-0000-0000-0000000000a2';
const P = '00000000-0000-0000-0000-00000000d301'; // project P (assigned to the PM)
const Q = '00000000-0000-0000-0000-00000000d302'; // project Q (unassigned)
const CUSTOMER = '00000000-0000-0000-0000-00000000d201';

const GRP = {
  asset: '00000000-0000-0000-0000-0000000000b1',
  liability: '00000000-0000-0000-0000-0000000000b2',
  equity: '00000000-0000-0000-0000-0000000000b3',
  income: '00000000-0000-0000-0000-0000000000b4',
  expense: '00000000-0000-0000-0000-0000000000b5',
};
const ACC = {
  cash: '00000000-0000-0000-0000-00000000a110', // 1100 ASSET
  inventory: '00000000-0000-0000-0000-00000000a130', // 1300 ASSET (inventory control)
  advance: '00000000-0000-0000-0000-00000000a125', // 1250 ASSET (staff advance)
  netPayable: '00000000-0000-0000-0000-00000000a220', // 2200 LIABILITY (salary payable)
  tdsPayable: '00000000-0000-0000-0000-00000000a221', // 2210 LIABILITY
  pfPayable: '00000000-0000-0000-0000-00000000a222', // 2220 LIABILITY
  salaryCost: '00000000-0000-0000-0000-00000000a520', // 5200 EXPENSE
};

const GODOWN = '00000000-0000-0000-0000-0000000d0001';
const ITEM1 = '00000000-0000-0000-0000-0000000d1001';
const ITEM2 = '00000000-0000-0000-0000-0000000d1002';
const CC = '00000000-0000-0000-0000-0000000dcc01';
const PURPOSE = '00000000-0000-0000-0000-0000000d0011';
const EMP = '00000000-0000-0000-0000-0000000de001';
const SALARY_SHEET = '00000000-0000-0000-0000-0000000d5501';
const SALARY_ENTRY = '00000000-0000-0000-0000-0000000d1e01';
const INV_ENTRY = '00000000-0000-0000-0000-0000000d1e02';
const REQUISITION = '00000000-0000-0000-0000-0000000d4e01';
const STOCK_JOURNAL = '00000000-0000-0000-0000-0000000d5301';

const admin: Actor = {
  userId: USER, companyId: CO, financialYearId: FY1, role: 'ACCOUNTS_TEAM',
  isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pmP: Actor = {
  userId: 'pm-user', companyId: CO, financialYearId: FY1, role: 'PROJECT_MANAGER',
  isUnscoped: false, assignedProjectIds: [P], approvalLimit: null,
};

describe('RPT inventory / requisition / HR reports (real Postgres, real projections + ledger)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let query: ReportQueryService;
  let rolesGuard: RolesGuard;

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
    await acc(ACC.inventory, '1300', 'Inventory', GRP.asset, 'ASSET');
    await acc(ACC.advance, '1250', 'Staff Advance', GRP.asset, 'ASSET');
    await acc(ACC.netPayable, '2200', 'Salary Payable', GRP.liability, 'LIABILITY');
    await acc(ACC.tdsPayable, '2210', 'TDS Payable', GRP.liability, 'LIABILITY');
    await acc(ACC.pfPayable, '2220', 'PF Payable', GRP.liability, 'LIABILITY');
    await acc(ACC.salaryCost, '5200', 'Salary Cost', GRP.expense, 'EXPENSE');

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

    // Dimensions
    await ds.query(`INSERT INTO godown (id, company_id, project_id, name) VALUES ($1,$2,$3,'Main Store')`, [GODOWN, CO, P]);
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-01','Labour')`, [CC, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Construction')`, [PURPOSE, CO, P]);
    const item = (id: string, code: string, name: string) =>
      ds.query(
        `INSERT INTO item (id, company_id, code, name, base_uom, default_account_id) VALUES ($1,$2,$3,$4,'PCS',$5)`,
        [id, CO, code, name, ACC.inventory],
      );
    await item(ITEM1, 'IT-01', 'Cement');
    await item(ITEM2, 'IT-02', 'Rebar');
    await ds.query(
      `INSERT INTO employee (id, company_id, employee_code, name, designation, work_base, wage_type, wage_amount, joining_date) VALUES ($1,$2,'E-01','Karim','Engineer','SITE','MONTHLY',60000,'2025-07-01')`,
      [EMP, CO],
    );

    // ── INV projection: stock_balance (INV owns these figures) + the inventory control journal entry ──
    const bal = (id: string, godown: string, item: string, qty: string, value: string, rate: string) =>
      ds.query(
        `INSERT INTO stock_balance (id, company_id, godown_id, item_id, quantity_on_hand, total_value, avg_rate) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, CO, godown, item, qty, value, rate],
      );
    await bal('00000000-0000-0000-0000-0000000db101', GODOWN, ITEM1, '150', '75000', '500');
    await bal('00000000-0000-0000-0000-0000000db102', GODOWN, ITEM2, '5', '250', '50');
    // Total stock value = 75250; the inventory control account '1300' must carry the same balance.
    await postEntry(INV_ENTRY, 'STOCK_JOURNAL', '2026-06-05', [
      { account: ACC.inventory, project: P, debit: '75250' },
      { account: ACC.cash, project: P, credit: '75250' },
    ]);

    // ── HR projection: the SALARY journal entry FIRST (salary_sheet.salary_entry_id FKs to it), then the
    // posted salary_sheet + line it reconciles to. Dr salary cost 70000 (gross+allowances); Cr net 59600 +
    // tds 3000 + pf 2400 + advance 5000. ──
    await postEntry(SALARY_ENTRY, 'SALARY', '2026-06-30', [
      { account: ACC.salaryCost, project: P, debit: '70000' },
      { account: ACC.netPayable, project: P, credit: '59600' },
      { account: ACC.tdsPayable, project: P, credit: '3000' },
      { account: ACC.pfPayable, project: P, credit: '2400' },
      { account: ACC.advance, project: P, credit: '5000' },
    ]);
    await ds.query(
      `INSERT INTO salary_sheet (id, company_id, financial_year_id, period_label, period_start, period_end, status, salary_entry_id, posted_at, posted_by)
       VALUES ($1,$2,$3,'Jun 2026','2026-06-01','2026-06-30','POSTED',$4, now(), $5)`,
      [SALARY_SHEET, CO, FY1, SALARY_ENTRY, USER],
    );
    await ds.query(
      `INSERT INTO salary_sheet_line (id, salary_sheet_id, employee_id, project_id, cost_centre_id, purpose_id, paid_days, gross_amount, allowances, tds, pf, advance_recovery, other_deductions, net_amount)
       VALUES ($1,$2,$3,$4,$5,$6,30,60000,10000,3000,2400,5000,0,59600)`,
      ['00000000-0000-0000-0000-0000000d5401', SALARY_SHEET, EMP, P, CC, PURPOSE],
    );

    // ── REQ projection: requisition + line (requested 100, issued 60 → variance 40) ──
    await ds.query(
      `INSERT INTO requisition (id, company_id, financial_year_id, requisition_no, requisition_seq, project_id, cost_centre_id, purpose_id, required_date, status)
       VALUES ($1,$2,$3,'REQ/2526/0001',1,$4,$5,$6,'2026-06-10','PARTIALLY_ISSUED')`,
      [REQUISITION, CO, FY1, P, CC, PURPOSE],
    );
    await ds.query(
      `INSERT INTO requisition_line (id, requisition_id, line_no, item_id, requested_quantity, issued_quantity, balance_quantity, uom)
       VALUES ($1,$2,1,$3,100,60,40,'PCS')`,
      ['00000000-0000-0000-0000-0000000d4c01', REQUISITION, ITEM1],
    );

    // ── INV Stock Journal: one posted TRANSFER (from/to godown) for the transfer summary ──
    await ds.query(
      `INSERT INTO stock_journal (id, company_id, financial_year_id, entry_no, voucher_date, mode, status, from_godown_id, to_godown_id, item_id, quantity, rate, value, project_id, cost_centre_id, purpose_id, approved_by_id, posted_at)
       VALUES ($1,$2,$3,'SJ/2526/0001','2026-06-12','TRANSFER','POSTED',$4,$4,$5,10,500,5000,$6,$7,$8,$9, now())`,
      [STOCK_JOURNAL, CO, FY1, GODOWN, ITEM1, P, CC, PURPOSE, USER],
    );

    // ── HR attendance: a few records in Jun-2026 (office employee) ──
    const att = (id: string, date: string, status: string) =>
      ds.query(
        `INSERT INTO attendance_record (id, company_id, financial_year_id, mode, attendance_date, project_id, employee_id, day_status)
         VALUES ($1,$2,$3,'OFFICE',$4,$5,$6,$7)`,
        [id, CO, FY1, date, P, EMP, status],
      );
    await att('00000000-0000-0000-0000-0000000da101', '2026-06-01', 'PRESENT');
    await att('00000000-0000-0000-0000-0000000da102', '2026-06-02', 'PRESENT');
    await att('00000000-0000-0000-0000-0000000da103', '2026-06-03', 'ABSENT');

    query = new ReportQueryService(
      new LedgerReadAdapter(ds),
      new InventoryReadAdapter(ds),
      new RequisitionReadAdapter(ds),
      new HrReadAdapter(ds),
      new ReportScopeService(),
    );
    rolesGuard = new RolesGuard(new Reflector(), new TypeOrmRoleRepository(ds), new TypeOrmPermissionRepository(ds));
  });

  interface Line { account: string; project?: string | null; debit?: string; credit?: string }
  let entrySeq = 0;
  async function postEntry(entryId: string, voucherType: string, date: string, lines: Line[]): Promise<void> {
    entrySeq += 1;
    await ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, is_reversal, reversal_of, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$5,$1,false,NULL,now(),$7)`,
        [entryId, CO, FY1, `${voucherType}/2526/${String(entrySeq).padStart(4, '0')}`, voucherType, date, USER],
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
  }

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  // ── Inventory ──────────────────────────────────────────────────────────────────────────────────
  it('stock valuation: totals tie to the inventory 1300 control-account balance (FR-RPT-021/-INV-005)', async () => {
    const r = await query.stockValuation({ financialYearId: FY1 }, admin);
    expect(r.rows).toHaveLength(2);
    expect(r.totals).toEqual({ totalValue: '75250.0000' });

    const [ctrl] = await ds.query(
      `SELECT COALESCE(SUM(l.debit - l.credit),0)::numeric(18,4)::text AS bal
         FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id
        WHERE e.company_id = $1 AND l.account_id = $2`,
      [CO, ACC.inventory],
    );
    expect(r.totals!.totalValue).toBe(ctrl.bal); // single source of truth — the books agree
  });

  it('stock valuation figures are INV’s verbatim (quantity/value/weighted-average rate)', async () => {
    const r = await query.stockValuation({ financialYearId: FY1, godownId: GODOWN, itemId: ITEM1 }, admin);
    expect(r.rows).toEqual([
      { godownId: GODOWN, itemId: ITEM1, quantityOnHand: '150.0000', totalValue: '75000.0000', weightedAverageRate: '500.0000', reorderLevel: null, asOfDate: null },
    ]);
  });

  it('low stock: only (godown,item) at/below the param threshold; missing threshold is a 400 (FR-RPT-022)', async () => {
    const r = await query.lowStock({ financialYearId: FY1, reorderLevel: '10' }, admin);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].itemId).toBe(ITEM2); // qty 5 ≤ 10; item1 (150) excluded
    expect(r.rows[0].reorderLevel).toBe('10.0000');
    await expect(query.lowStock({ financialYearId: FY1 }, admin)).rejects.toBeInstanceOf(ValidationError);
  });

  it('stock valuation as-of a date before any movement → rows:[] / value 0 (SRS edge 11)', async () => {
    const r = await query.stockValuation({ asOf: '2020-01-01' }, admin);
    expect(r.rows).toEqual([]);
    expect(r.totals).toEqual({ totalValue: '0.0000' });
  });

  it('stock-transfer summary: lists the posted Stock Journal transfer (FR-RPT-023)', async () => {
    const p = await query.stockTransferSummary({ financialYearId: FY1, dateFrom: '2026-06-01', dateTo: '2026-06-30' }, admin);
    expect(p.total).toBe(1);
    expect(p.items[0]).toMatchObject({ stockJournalId: STOCK_JOURNAL, mode: 'TRANSFER', itemId: ITEM1, quantity: '10.0000', value: '5000.0000', approverId: USER });
  });

  // ── Requisition ──────────────────────────────────────────────────────────────────────────────
  it('requisition vs issue: variance = requested − issued (FR-RPT-024)', async () => {
    const p = await query.requisitionVsIssue({ financialYearId: FY1 }, admin);
    expect(p.total).toBe(1);
    expect(p.items[0]).toMatchObject({ requisitionId: REQUISITION, requestedQty: '100.0000', issuedQty: '60.0000', varianceQty: '40.0000' });
  });

  // ── HR ─────────────────────────────────────────────────────────────────────────────────────────
  it('salary register: totals tie to the posted SALARY ledger entry (FR-RPT-027)', async () => {
    const r = await query.salaryRegister({ salaryRunId: SALARY_SHEET }, admin);
    expect(r.rows).toHaveLength(1);
    expect(r.totals!.net).toBe('59600.0000');
    expect(new Decimal(r.totals!.gross).plus(r.totals!.allowances).toFixed(4)).toBe('70000.0000');

    // Net total = the SALARY entry's credit to the salary-payable account; cost debit = gross + allowances.
    const [net] = await ds.query(
      `SELECT COALESCE(SUM(l.credit),0)::numeric(18,4)::text AS c FROM journal_line l WHERE l.journal_entry_id = $1 AND l.account_id = $2`,
      [SALARY_ENTRY, ACC.netPayable],
    );
    const [cost] = await ds.query(
      `SELECT COALESCE(SUM(l.debit),0)::numeric(18,4)::text AS d FROM journal_line l WHERE l.journal_entry_id = $1 AND l.account_id = $2`,
      [SALARY_ENTRY, ACC.salaryCost],
    );
    expect(r.totals!.net).toBe(net.c);
    expect(new Decimal(r.totals!.gross).plus(r.totals!.allowances).toFixed(4)).toBe(cost.d);
  });

  it('salary register: resolvable by (financialYearId + month) too', async () => {
    const r = await query.salaryRegister({ financialYearId: FY1, month: '2026-06' }, admin);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].net).toBe('59600.0000');
  });

  it('attendance summary: rolls up day-status counts + head count for the month (FR-RPT-026)', async () => {
    const p = await query.attendanceSummary({ month: '2026-06' }, admin);
    expect(p.total).toBe(1);
    expect(p.items[0]).toMatchObject({ employeeId: EMP, daysPresent: 2, absent: 1, paidLeave: 0, unpaidLeave: 0, headCountTotal: 3 });
  });

  it('attendance summary: an empty month is a valid empty report (200, rows:[]) (SRS edge 4)', async () => {
    const p = await query.attendanceSummary({ month: '2020-01' }, admin);
    expect(p.items).toEqual([]);
    expect(p.total).toBe(0);
  });

  it('scope: a PM is auto-filtered to assigned projects; an explicit unassigned project is 403', async () => {
    const p = await query.requisitionVsIssue({ financialYearId: FY1 }, pmP);
    expect(p.total).toBe(1); // requisition is on project P (assigned)
    await expect(query.requisitionVsIssue({ financialYearId: FY1, projectId: Q }, pmP)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── RBAC smoke: prove the owning-module READ gate (HR:READ / INV:READ) ──
  describe('ReportsController RBAC — real RolesGuard against a real Postgres-backed Role/Permission repo', () => {
    const HR_ROLE = '00000000-0000-0000-0000-0000000e4b10';
    const PM_ROLE = '00000000-0000-0000-0000-0000000e4b11';
    const ACC_ROLE = '00000000-0000-0000-0000-0000000e4b12';
    const hrActor: Actor = { ...admin, userId: 'hr-user', role: 'HR_MANAGER', isUnscoped: false, assignedProjectIds: [P] };
    const pmActor: Actor = { ...pmP };
    const accActor: Actor = { ...admin, role: 'ACCOUNTS_TEAM' };

    function mockContext(user: Actor | undefined, requirements: PermissionRequirement[]): ExecutionContext {
      jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requirements);
      return {
        getHandler: () => function handler() {},
        getClass: () => class ReportsController {},
        switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
      } as unknown as ExecutionContext;
    }

    beforeAll(async () => {
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'HR_MANAGER',false,1) ON CONFLICT DO NOTHING`, [HR_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1) ON CONFLICT DO NOTHING`, [PM_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ACCOUNTS_TEAM',true,1) ON CONFLICT DO NOTHING`, [ACC_ROLE, CO]);
      // HR_MANAGER → HR:READ; ACCOUNTS_TEAM → INV:READ (per this brief's seed change). PM holds NEITHER
      // HR:READ nor INV:READ in this fixture — proving the owning-module gate blocks a role without it.
      await ds.query(`INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(),$1,$2,'HR','READ','ASSIGNED',1)`, [HR_ROLE, CO]);
      await ds.query(`INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(),$1,$2,'INV','READ','ALL',1)`, [ACC_ROLE, CO]);
    });

    it('403: PM (no HR:READ) is FORBIDDEN on salary-register (HR gate — SRS edge 3 / AC role-visibility)', async () => {
      const ctx = mockContext(pmActor, [{ module: 'HR', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('200: HR_MANAGER (HR:READ) may run salary-register', async () => {
      const ctx = mockContext(hrActor, [{ module: 'HR', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('200: ACCOUNTS_TEAM (INV:READ) may run stock-valuation', async () => {
      const ctx = mockContext(accActor, [{ module: 'INV', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('403: PM (no INV:READ) is FORBIDDEN on stock-valuation (INV gate)', async () => {
      const ctx = mockContext(pmActor, [{ module: 'INV', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
