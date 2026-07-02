/**
 * RPT export integration (RPT #30 · FR-RPT-029/-030/-031) — Testcontainers Postgres, real LED/MAS
 * migrations + seeded ledger (mirrors reports-financial.int-spec.ts). Drives the real RPT export path end
 * to end through the ReportsController (ReportQueryService → FileExporter → binary download) and proves:
 *   - trial-balance at format=excel: the parsed .xlsx totals equal the JSON totals (numbers identical, AC2);
 *   - trial-balance at format=pdf: a valid %PDF document (AC7);
 *   - response headers: Content-Type, Content-Disposition filename, X-Request-Id (AC3/FR-RPT-031);
 *   - JSON stays on the { data, meta } envelope path (returns a ReportResult, not a StreamableFile);
 *   - an empty-range export is a well-formed file, not an error (AC8);
 *   - no write path — no journal_entry/journal_line row added, no PostingService (AC9).
 */
import { StreamableFile } from '@nestjs/common';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';

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
import { CompanyQueryService } from '../src/modules/master-data/company/read/company.query-service';
import { JsonExporter } from '../src/reports/infrastructure/exporters/json.exporter';
import { ExcelExporter } from '../src/reports/infrastructure/exporters/excel.exporter';
import { PdfExporter } from '../src/reports/infrastructure/exporters/pdf.exporter';
import { ReportsController } from '../src/reports/presentation/reports.controller';
import { TrialBalanceReportQueryDto } from '../src/reports/presentation/dto/reports-query.dto';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c1';
const FY1 = '00000000-0000-0000-0000-0000000000f2';
const PERIOD = '00000000-0000-0000-0000-0000000000e2';
const USER = '00000000-0000-0000-0000-0000000000a2';
const CUSTOMER = '00000000-0000-0000-0000-00000000d201';
const P = '00000000-0000-0000-0000-00000000d301';

const GRP = {
  asset: '00000000-0000-0000-0000-0000000000b1',
  liability: '00000000-0000-0000-0000-0000000000b2',
  equity: '00000000-0000-0000-0000-0000000000b3',
  income: '00000000-0000-0000-0000-0000000000b4',
  expense: '00000000-0000-0000-0000-0000000000b5',
};
const ACC = {
  bank: '00000000-0000-0000-0000-00000000a111',
  capital: '00000000-0000-0000-0000-00000000a310',
  revenue: '00000000-0000-0000-0000-00000000a410',
  expense: '00000000-0000-0000-0000-00000000a510',
  ar: '00000000-0000-0000-0000-00000000a120',
};

const admin: Actor = {
  userId: USER, companyId: CO, financialYearId: FY1, role: 'ACCOUNTS_TEAM',
  isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};

/** A minimal Express-like response capturing headers set by the controller. */
function makeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    _headers: headers,
  };
}
function makeReq(id = 'req-export-1') {
  return { id, headers: { 'x-request-id': id } };
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function xlsxFlat(buffer: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const flat: string[] = [];
  wb.worksheets[0].eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (cell) => flat.push(cell.value == null ? '' : String(cell.value)));
  });
  return flat;
}

interface Line {
  account: string;
  project?: string | null;
  debit?: string;
  credit?: string;
}

describe('RPT export end-to-end (real Postgres ledger → ReportsController → binary download)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let controller: ReportsController;
  let entrySeq = 0;

  async function postEntry(voucherType: string, date: string, lines: Line[]): Promise<void> {
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
      ds.query(`INSERT INTO account (id, company_id, code, name, account_group_id, type, opening_balance) VALUES ($1,$2,$3,$4,$5,$6,NULL)`, [id, CO, code, name, group, type]);
    await acc(ACC.bank, '1110', 'Bank — Operating', GRP.asset, 'ASSET');
    await acc(ACC.ar, '1200', 'Accounts Receivable', GRP.asset, 'ASSET');
    await acc(ACC.capital, '3100', 'Share Capital', GRP.equity, 'EQUITY');
    await acc(ACC.revenue, '4100', 'Contract Revenue', GRP.income, 'INCOME');
    await acc(ACC.expense, '5100', 'Site Expense', GRP.expense, 'EXPENSE');

    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,'Customer A',true,false,'+8801700000000')`,
      [CUSTOMER, CO],
    );
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,'P-01','Site P',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [P, CO, CUSTOMER, USER],
    );

    await postEntry('CONTRA', '2026-06-01', [
      { account: ACC.bank, debit: '10000' },
      { account: ACC.capital, credit: '10000' },
    ]);
    await postEntry('GENERAL', '2026-06-10', [
      { account: ACC.expense, project: P, debit: '3200' },
      { account: ACC.bank, project: P, credit: '3200' },
    ]);
    await postEntry('SALES', '2026-06-15', [
      { account: ACC.ar, project: P, debit: '4000' },
      { account: ACC.revenue, project: P, credit: '4000' },
    ]);

    const query = new ReportQueryService(
      new LedgerReadAdapter(ds),
      new InventoryReadAdapter(ds),
      new RequisitionReadAdapter(ds),
      new HrReadAdapter(ds),
      new ReportScopeService(),
    );
    const exporters = [new JsonExporter(), new ExcelExporter(), new PdfExporter()];
    controller = new ReportsController(query, new CompanyQueryService(ds), exporters);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  function dto(format?: 'json' | 'excel' | 'pdf'): TrialBalanceReportQueryDto {
    return Object.assign(new TrialBalanceReportQueryDto(), { financialYearId: FY1, format });
  }

  it('format=json stays on the { data, meta } envelope path (returns a ReportResult, not a file)', async () => {
    const res = makeRes();
    const out = await controller.trialBalance(dto('json'), admin, res as never, makeReq() as never);
    expect(out).not.toBeInstanceOf(StreamableFile);
    expect((out as { reportName: string }).reportName).toBe('trial-balance');
    expect((out as { totals: Record<string, string> }).totals.debit).toBe(
      (out as { totals: Record<string, string> }).totals.credit,
    );
  });

  it('format=excel: binary download; parsed .xlsx totals equal the JSON totals (AC2/AC3)', async () => {
    const jsonRes = makeRes();
    const json = (await controller.trialBalance(dto('json'), admin, jsonRes as never, makeReq() as never)) as {
      totals: Record<string, string>;
    };

    const res = makeRes();
    const out = await controller.trialBalance(dto('excel'), admin, res as never, makeReq('rid-xlsx') as never);
    expect(out).toBeInstanceOf(StreamableFile);

    expect(res._headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res._headers['Content-Disposition']).toMatch(/attachment; filename="trial-balance-consolidated-\d{2}-\d{2}-\d{4}\.xlsx"/);
    expect(res._headers['X-Request-Id']).toBe('rid-xlsx');

    const buf = await collect((out as StreamableFile).getStream());
    const flat = await xlsxFlat(buf);
    // totals identical to JSON, and the statutory BIN/TIN block is present
    expect(flat).toContainEqual(json.totals.debit);
    expect(flat).toContain('BIN: 1234567890123    TIN: 123456789012');
    expect(flat).toContainEqual(expect.stringContaining('Trial Balance'));
  });

  it('format=pdf: a valid %PDF binary download with correct headers (AC7/AC3)', async () => {
    const res = makeRes();
    const out = await controller.trialBalance(dto('pdf'), admin, res as never, makeReq('rid-pdf') as never);
    expect(out).toBeInstanceOf(StreamableFile);
    expect(res._headers['Content-Type']).toBe('application/pdf');
    expect(res._headers['Content-Disposition']).toMatch(/filename="trial-balance-consolidated-\d{2}-\d{2}-\d{4}\.pdf"/);
    expect(res._headers['X-Request-Id']).toBe('rid-pdf');

    const buf = await collect((out as StreamableFile).getStream());
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('empty-range export is a well-formed file, not an error (AC8)', async () => {
    const q = Object.assign(new TrialBalanceReportQueryDto(), {
      financialYearId: FY1, format: 'excel', dateFrom: '2020-01-01', dateTo: '2020-01-31',
    });
    const res = makeRes();
    const out = await controller.trialBalance(q, admin, res as never, makeReq() as never);
    const flat = await xlsxFlat(await collect((out as StreamableFile).getStream()));
    expect(flat).toContain('No data');
    expect(flat).toContainEqual('0.0000'); // zeroed totals, not an error
  });

  it('no write path — exporting does not add any journal_entry / journal_line row (AC9)', async () => {
    const before = await ds.query('SELECT (SELECT count(*) FROM journal_entry) je, (SELECT count(*) FROM journal_line) jl');
    const res = makeRes();
    const out = await controller.trialBalance(dto('excel'), admin, res as never, makeReq() as never);
    await collect((out as StreamableFile).getStream());
    const after = await ds.query('SELECT (SELECT count(*) FROM journal_entry) je, (SELECT count(*) FROM journal_line) jl');
    expect(after[0].je).toBe(before[0].je);
    expect(after[0].jl).toBe(before[0].jl);
  });
});
