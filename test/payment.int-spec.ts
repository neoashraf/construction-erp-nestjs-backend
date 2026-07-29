/**
 * PAY (Payments) integration — Testcontainers Postgres, real migrations + LED triggers + the real
 * PostingService/LED/NUM/PER + real posted PUR/HR fixtures (SQL). Proves the full payment post path
 * end-to-end per the brief's DoD:
 *   - supplier payment posts a balanced PAYMENT entry (Dr AP party-tagged + Dr Bank Charges / Cr Bank),
 *     the bill outstanding drops by the allocation;
 *   - daily-labour settle + true-up posts Dr Labour Payable (full accrued) / Cr Labour Cost / Cr Cash;
 *     the labour payable is cleared and the HR accrual entry is byte-for-byte unchanged;
 *   - salary payment posts Dr Salary Payable / Cr Bank;
 *   - a gapless PAYMENT number is allocated at post; a DRAFT has entry_no null; a rolled-back post (closed
 *     period) consumes NO number and leaves the payment DRAFT;
 *   - cancel writes a linked reversal (original entry + number retained), the allocation drops out of PAY's
 *     applied projection, and the payable's outstanding rises back;
 *   - RBAC guard smoke test (real RolesGuard against a real Postgres-backed Role/Permission repo).
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { NumberingSeriesOrmEntity } from '../src/core/numbering/infrastructure/numbering-series.orm-entity';
import { AccountingPeriodOrmEntity } from '../src/core/period/infrastructure/accounting-period.orm-entity';
import { JournalEntryOrmEntity } from '../src/core/posting/infrastructure/journal-entry.orm-entity';
import { JournalLineOrmEntity } from '../src/core/posting/infrastructure/journal-line.orm-entity';
import { AccountOrmEntity } from '../src/modules/master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { PartyOrmEntity } from '../src/modules/master-data/party/infrastructure/party.orm-entity';
import { ProjectOrmEntity } from '../src/modules/master-data/project/infrastructure/project.orm-entity';
import { PaymentVoucherOrmEntity } from '../src/modules/payment/infrastructure/payment-voucher.orm-entity';
import { PaymentAllocationOrmEntity } from '../src/modules/payment/infrastructure/payment-allocation.orm-entity';
import { PurchaseBillOrmEntity } from '../src/modules/purchase/infrastructure/purchase-bill.orm-entity';
import { LabourPayableOrmEntity } from '../src/modules/hr/infrastructure/labour-payable.orm-entity';
import { SalarySheetOrmEntity } from '../src/modules/hr/infrastructure/salary-sheet.orm-entity';
import { SalarySheetLineOrmEntity } from '../src/modules/hr/infrastructure/salary-sheet-line.orm-entity';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateUser1700000700000 } from '../src/database/migrations/1700000700000-CreateUser';
import { CreateRbacAndAudit1700000800000 } from '../src/database/migrations/1700000800000-CreateRbacAndAudit';
import { RbacV2ResourcePermissions1700002300000 } from '../src/database/migrations/1700002300000-RbacV2ResourcePermissions';
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
// AddLatePenalty ALTERs attendance_setting, so its creating migration has to run first even though
// this spec never reads attendance config — SalarySheetOrmEntity now maps pre_post_warnings, and a
// DataSource whose schema lacks the column fails every SELECT through the entity.
import { CreateAttendanceReportConfig1784700000000 } from '../src/database/migrations/1784700000000-CreateAttendanceReportConfig';
import { AddLatePenalty1785000000000 } from '../src/database/migrations/1785000000000-AddLatePenalty';
import { CreateRequisitionIssue1700001900000 } from '../src/database/migrations/1700001900000-CreateRequisitionIssue';
import { CreatePurchasePoBill1700002000000 } from '../src/database/migrations/1700002000000-CreatePurchasePoBill';
import { CreatePurchaseGrn1700002100000 } from '../src/database/migrations/1700002100000-CreatePurchaseGrn';
import { CreatePayment1700002200000 } from '../src/database/migrations/1700002200000-CreatePayment';

import { TypeOrmJournalEntryRepository } from '../src/core/posting/infrastructure/typeorm-journal-entry.repository';
import { TypeOrmNumberingService } from '../src/core/numbering/infrastructure/typeorm-numbering.service';
import { TypeOrmAccountingPeriodRepository } from '../src/core/period/infrastructure/typeorm-accounting-period.repository';
import { PeriodServiceImpl } from '../src/core/period/application/period.service';
import { OverviewTagMatrix } from '../src/core/posting/domain/tag-matrix';
import {
  AllowAllMasterLookupService,
  AllowAllProjectStatusService,
} from '../src/core/posting/infrastructure/mas-seam.adapters';
import { PostingService } from '../src/core/posting/application/posting.service';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { Actor } from '../src/core/tenancy/tenant-context';

import { TypeOrmPaymentRepository } from '../src/modules/payment/infrastructure/typeorm-payment.repository';
import { PayableLookupAdapter } from '../src/modules/payment/infrastructure/payable-lookup.adapter';
import { PaymentAccountMapAdapter } from '../src/modules/payment/infrastructure/payment-account-map.adapter';
import { CreatePaymentUseCase } from '../src/modules/payment/application/create-payment.usecase';
import { PostPaymentUseCase } from '../src/modules/payment/application/post-payment.usecase';
import { CancelPaymentUseCase } from '../src/modules/payment/application/cancel-payment.usecase';

// RolesGuard smoke test deps (mandatory per skill §13).
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
// JwtAuthGuard raises DOMAIN errors, not Nest exceptions — the domain layer must not
// import from @nestjs/common (nestjs-author §9); the global filter maps this to 401.
import { UnauthenticatedError } from '../src/common/errors/domain-error';
import { Reflector } from '@nestjs/core';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { JwtAuthGuard } from '../src/core/auth/presentation/jwt-auth.guard';
import { PermissionRequirement } from '../src/core/auth/presentation/require-permission.decorator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c1';
const FY1 = '00000000-0000-0000-0000-0000000000f2';
const PERIOD = '00000000-0000-0000-0000-0000000000e2';
const USER = '00000000-0000-0000-0000-0000000000a2';
const GROUP = '00000000-0000-0000-0000-0000000000b2';
const PROJECT = '00000000-0000-0000-0000-00000000d101';
const CC = '00000000-0000-0000-0000-00000000d102';
const PURPOSE = '00000000-0000-0000-0000-00000000d103';
const SUPPLIER = '00000000-0000-0000-0000-00000000d104';
const EMPLOYEE = '00000000-0000-0000-0000-00000000d107';

const ACC = {
  ap: '00000000-0000-0000-0000-00000000a100', // 2100 Accounts Payable
  labourPayable: '00000000-0000-0000-0000-00000000a231', // 2310 Daily-Labour Payable
  salaryPayable: '00000000-0000-0000-0000-00000000a230', // 2300 Salary Payable
  labourCost: '00000000-0000-0000-0000-00000000a511', // 5110 Labour Expense
  bankCharges: '00000000-0000-0000-0000-00000000a620', // 6200 Bank Charges
  cash: '00000000-0000-0000-0000-00000000a110', // 1100 Cash
  bank: '00000000-0000-0000-0000-00000000a111', // 1110 Bank
};

const actor: Actor = {
  userId: USER,
  companyId: CO,
  financialYearId: FY1,
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

describe('Payments (real Postgres + real PostingService + real posted PUR/HR fixtures)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let createPayment: CreatePaymentUseCase;
  let postPayment: PostPaymentUseCase;
  let cancelPayment: CancelPaymentUseCase;
  let payableLookup: PayableLookupAdapter;
  let rolesGuard: RolesGuard;
  let jwtAuthGuard: JwtAuthGuard;

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
        PaymentVoucherOrmEntity,
        PaymentAllocationOrmEntity,
        PurchaseBillOrmEntity,
        LabourPayableOrmEntity,
        SalarySheetOrmEntity,
        SalarySheetLineOrmEntity,
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
        RbacV2ResourcePermissions1700002300000,
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
        CreateAttendanceReportConfig1784700000000,
        AddLatePenalty1785000000000,
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
    await ds.query(`INSERT INTO account_group (id, company_id, name, parent_group_id, type) VALUES ($1,$2,'Root',NULL,'ASSET')`, [
      GROUP,
      CO,
    ]);

    const acc = (id: string, code: string, name: string, type: string) =>
      ds.query(
        `INSERT INTO account (id, company_id, code, name, account_group_id, type, opening_balance) VALUES ($1,$2,$3,$4,$5,$6,NULL)`,
        [id, CO, code, name, GROUP, type],
      );
    await acc(ACC.ap, '2100', 'Accounts Payable', 'LIABILITY');
    await acc(ACC.labourPayable, '2310', 'Daily-Labour Payable', 'LIABILITY');
    await acc(ACC.salaryPayable, '2300', 'Salary Payable', 'LIABILITY');
    await acc(ACC.labourCost, '5110', 'Labour Expense', 'EXPENSE');
    await acc(ACC.bankCharges, '6200', 'Bank Charges', 'EXPENSE');
    await acc(ACC.cash, '1100', 'Cash in Hand', 'ASSET');
    await acc(ACC.bank, '1110', 'Bank — Operating', 'ASSET');

    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,'Supplier A',false,true,'+8801700000000')`,
      [SUPPLIER, CO],
    );
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,'P-01','Site A',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [PROJECT, CO, SUPPLIER, USER],
    );
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Slab','Slab')`, [CC, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Labour')`, [PURPOSE, CO, PROJECT]);
    await ds.query(
      `INSERT INTO employee (id, company_id, employee_code, name, designation, work_base, wage_type, wage_amount, joining_date, status)
       VALUES ($1,$2,'E-01','Karim','Engineer','HEAD_OFFICE','MONTHLY',60000,'2025-07-01','ACTIVE')`,
      [EMPLOYEE, CO],
    );

    const uow = new TypeOrmUnitOfWork(ds);
    const ids = new UuidIdGenerator();
    const clock = { now: () => new Date('2026-06-30T10:00:00Z') };
    const posting = new PostingService(
      new TypeOrmJournalEntryRepository(ds),
      new TypeOrmNumberingService(ids),
      new PeriodServiceImpl(new TypeOrmAccountingPeriodRepository(ds)),
      new OverviewTagMatrix(),
      new AllowAllProjectStatusService(),
      new AllowAllMasterLookupService(),
      ids,
      clock,
    );
    const repo = new TypeOrmPaymentRepository(ds);
    payableLookup = new PayableLookupAdapter(ds);
    const accountMap = new PaymentAccountMapAdapter(ds);
    const audit = { record: async () => undefined };

    createPayment = new CreatePaymentUseCase(repo, payableLookup, audit as never, uow, ids);
    postPayment = new PostPaymentUseCase(repo, payableLookup, accountMap, posting, audit as never, uow, clock);
    cancelPayment = new CancelPaymentUseCase(repo, posting, audit as never, uow);

    rolesGuard = new RolesGuard(new Reflector(), new TypeOrmRoleRepository(ds), new TypeOrmPermissionRepository(ds));
    jwtAuthGuard = new JwtAuthGuard();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await ds.query(
      'TRUNCATE payment_allocation, payment_voucher, journal_line, journal_entry, purchase_bill, labour_payable, salary_sheet_line, salary_sheet, numbering_series RESTART IDENTITY CASCADE',
    );
  });

  async function createPurchaseBill(seq: number, net = '200000'): Promise<string> {
    const id = `00000000-0000-0000-0000-0000000b${String(seq).padStart(4, '0')}`;
    await ds.query(
      `INSERT INTO purchase_bill (id, company_id, financial_year_id, project_id, supplier_id, bill_date, due_date, gross_amount, net_payable_amount, status)
       VALUES ($1,$2,$3,$4,$5,'2026-06-15','2026-07-15',$6,$6,'POSTED')`,
      [id, CO, FY1, PROJECT, SUPPLIER, net],
    );
    return id;
  }

  /** A confirmed daily-labour payable (accrued) with a real posted DAILY_LABOUR_ACCRUAL entry behind it. */
  async function createLabourPayable(seq: number, accrued = '50000'): Promise<string> {
    const entryId = `00000000-0000-0000-0000-0000000c${String(seq).padStart(4, '0')}`;
    await ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, is_reversal, reversal_of, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,'DAILY_LABOUR_ACCRUAL','2026-06-20','AttendanceRecord',$1,false,NULL,now(),$5)`,
        [entryId, CO, FY1, `DLA/2526/000${seq}`, USER],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, debit, credit)
         VALUES (gen_random_uuid(),$1,1,$2,$3,$4,$5,$6,0)`,
        [entryId, ACC.labourCost, PROJECT, CC, PURPOSE, accrued],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, debit, credit)
         VALUES (gen_random_uuid(),$1,2,$2,$3,$4,0,$5)`,
        [entryId, ACC.labourPayable, PROJECT, CC, accrued],
      );
    });
    const id = `00000000-0000-0000-0000-0000000d${String(seq).padStart(4, '0')}`;
    await ds.query(
      `INSERT INTO labour_payable (id, company_id, financial_year_id, project_id, cost_centre_id, accrual_date, accrued_amount, accrual_entry_id, settled_amount, status)
       VALUES ($1,$2,$3,$4,$5,'2026-06-20',$6,$7,0,'OUTSTANDING')`,
      [id, CO, FY1, PROJECT, CC, accrued, entryId],
    );
    return id;
  }

  async function createSalarySheet(seq: number, net = '480000'): Promise<string> {
    const id = `00000000-0000-0000-0000-0000000e${String(seq).padStart(4, '0')}`;
    await ds.query(
      `INSERT INTO salary_sheet (id, company_id, financial_year_id, period_label, period_start, period_end, status)
       VALUES ($1,$2,$3,'2026-06','2026-06-01','2026-06-30','POSTED')`,
      [id, CO, FY1],
    );
    await ds.query(
      `INSERT INTO salary_sheet_line (id, salary_sheet_id, employee_id, project_id, cost_centre_id, purpose_id, gross_amount, net_amount)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$6)`,
      [id, EMPLOYEE, PROJECT, CC, PURPOSE, net],
    );
    return id;
  }

  it('supplier payment: posts a balanced PAYMENT (Dr AP party + Dr Bank Charges / Cr Bank); bill outstanding drops', async () => {
    const billId = await createPurchaseBill(1, '200000');

    const before = await payableLookup.resolve('PURCHASE_BILL', billId, CO);
    expect(before?.remainingOutstanding.amount.toFixed(4)).toBe('200000.0000');

    const { id } = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'BANK_TRANSFER',
        paymentAccountId: ACC.bank,
        chequeTxnRef: 'TXN-PV-1',
        paymentAmount: '200150',
        bankChargesAmount: '150',
        bankChargesProjectId: PROJECT,
        bankChargesCostCentreId: CC,
        bankChargesPurposeId: PURPOSE,
        allocations: [{ payableType: 'PURCHASE_BILL', payableId: billId, amountAllocated: '200000' }],
      },
      actor,
    );

    let [v] = await ds.query(`SELECT status, entry_no FROM payment_voucher WHERE id=$1`, [id]);
    expect(v.status).toBe('DRAFT');
    expect(v.entry_no).toBeNull();

    const res = await postPayment.execute(id, actor);
    const [entry] = await ds.query(`SELECT entry_no, voucher_type FROM journal_entry WHERE id=$1`, [res.entryId]);
    expect(entry.voucher_type).toBe('PAYMENT');
    expect(res.entryNo).toMatch(/^PV\//);

    const [sum] = await ds.query(
      `SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`,
      [res.entryId],
    );
    expect(sum.dr).toBe(sum.cr);
    expect(sum.dr).toBe('200150.0000');

    const [ap] = await ds.query(
      `SELECT debit::text d, party_id, project_id, cost_centre_id, purpose_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`,
      [res.entryId, ACC.ap],
    );
    expect(ap.d).toBe('200000.0000');
    expect(ap.party_id).toBe(SUPPLIER);
    expect(ap).toMatchObject({ project_id: null, cost_centre_id: null, purpose_id: null });

    const [charge] = await ds.query(
      `SELECT debit::text d, project_id, cost_centre_id, purpose_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`,
      [res.entryId, ACC.bankCharges],
    );
    expect(charge.d).toBe('150.0000');
    expect(charge).toMatchObject({ project_id: PROJECT, cost_centre_id: CC, purpose_id: PURPOSE });

    const [bank] = await ds.query(
      `SELECT credit::text c, party_id, project_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`,
      [res.entryId, ACC.bank],
    );
    expect(bank.c).toBe('200150.0000');
    expect(bank).toMatchObject({ party_id: null, project_id: null });

    [v] = await ds.query(`SELECT status, entry_no, journal_entry_id FROM payment_voucher WHERE id=$1`, [id]);
    expect(v.status).toBe('POSTED');
    expect(v.entry_no).toBe(res.entryNo);
    expect(v.journal_entry_id).toBe(res.entryId);

    const after = await payableLookup.resolve('PURCHASE_BILL', billId, CO);
    expect(after?.remainingOutstanding.amount.toFixed(4)).toBe('0.0000');
  });

  it('daily-labour settle + true-up: Dr Labour Payable (full accrued) / Cr Labour Cost / Cr Cash; accrual unchanged', async () => {
    const lpId = await createLabourPayable(2, '50000');
    const accrualBefore = await ds.query(
      `SELECT account_id, debit::text d, credit::text c FROM journal_line jl JOIN journal_entry je ON je.id = jl.journal_entry_id
        WHERE je.source_id = (SELECT accrual_entry_id FROM labour_payable WHERE id=$1) ORDER BY line_no`,
      [lpId],
    );

    const { id } = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'CASH',
        paymentAccountId: ACC.cash,
        paymentAmount: '49800',
        bankChargesAmount: '0',
        allocations: [{ payableType: 'LABOUR_PAYABLE', payableId: lpId, amountAllocated: '49800' }],
      },
      actor,
    );
    const res = await postPayment.execute(id, actor);

    const [sum] = await ds.query(
      `SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`,
      [res.entryId],
    );
    expect(sum.dr).toBe(sum.cr);
    expect(sum.dr).toBe('50000.0000');

    const [lp] = await ds.query(`SELECT debit::text d, party_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [
      res.entryId,
      ACC.labourPayable,
    ]);
    expect(lp.d).toBe('50000.0000'); // full accrued cleared
    expect(lp.party_id).toBeNull();

    const [cost] = await ds.query(
      `SELECT credit::text c, project_id, cost_centre_id, purpose_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`,
      [res.entryId, ACC.labourCost],
    );
    expect(cost.c).toBe('200.0000'); // cost down (paid < accrued)
    expect(cost).toMatchObject({ project_id: PROJECT, cost_centre_id: CC, purpose_id: PURPOSE });

    const [cash] = await ds.query(`SELECT credit::text c FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [
      res.entryId,
      ACC.cash,
    ]);
    expect(cash.c).toBe('49800.0000');

    // The HR accrual entry is byte-for-byte unchanged; the labour payable is fully applied.
    const accrualAfter = await ds.query(
      `SELECT account_id, debit::text d, credit::text c FROM journal_line jl JOIN journal_entry je ON je.id = jl.journal_entry_id
        WHERE je.source_id = (SELECT accrual_entry_id FROM labour_payable WHERE id=$1) ORDER BY line_no`,
      [lpId],
    );
    expect(accrualAfter).toEqual(accrualBefore);

    const settled = await payableLookup.resolve('LABOUR_PAYABLE', lpId, CO);
    expect(settled?.remainingOutstanding.amount.toFixed(4)).toBe('200.0000');
  });

  it('salary payment: posts Dr Salary Payable / Cr Bank', async () => {
    const sheetId = await createSalarySheet(3, '480000');
    const { id } = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'CHEQUE',
        paymentAccountId: ACC.bank,
        chequeTxnRef: 'CHQ-77',
        paymentAmount: '480000',
        bankChargesAmount: '0',
        allocations: [{ payableType: 'SALARY', payableId: sheetId, amountAllocated: '480000' }],
      },
      actor,
    );
    const res = await postPayment.execute(id, actor);

    const [sum] = await ds.query(
      `SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`,
      [res.entryId],
    );
    expect(sum.dr).toBe(sum.cr);
    expect(sum.dr).toBe('480000.0000');
    const [sp] = await ds.query(`SELECT debit::text d, party_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [
      res.entryId,
      ACC.salaryPayable,
    ]);
    expect(sp.d).toBe('480000.0000');
    expect(sp.party_id).toBeNull();
    const [bank] = await ds.query(`SELECT credit::text c FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [
      res.entryId,
      ACC.bank,
    ]);
    expect(bank.c).toBe('480000.0000');
  });

  it('closed period: a post rolls back — payment DRAFT, no entry, no PAYMENT number consumed', async () => {
    const billId = await createPurchaseBill(4, '100000');
    const { id } = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'CASH',
        paymentAccountId: ACC.cash,
        paymentAmount: '100000',
        bankChargesAmount: '0',
        allocations: [{ payableType: 'PURCHASE_BILL', payableId: billId, amountAllocated: '100000' }],
      },
      actor,
    );
    await ds.query(`UPDATE accounting_period SET status='CLOSED' WHERE id=$1`, [PERIOD]);
    try {
      await expect(postPayment.execute(id, actor)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry WHERE source_type='PaymentVoucher'`);
      expect(entries).toBe(0);
      const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series WHERE voucher_type='PAYMENT'`);
      expect(series).toBe(0);
      const [v] = await ds.query(`SELECT status, entry_no FROM payment_voucher WHERE id=$1`, [id]);
      expect(v.status).toBe('DRAFT');
      expect(v.entry_no).toBeNull();
    } finally {
      await ds.query(`UPDATE accounting_period SET status='OPEN' WHERE id=$1`, [PERIOD]);
    }
  });

  it('cancel: writes a linked reversal (original unchanged, number retained); bill outstanding rises back', async () => {
    const billId = await createPurchaseBill(5, '200000');
    const { id } = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'BANK_TRANSFER',
        paymentAccountId: ACC.bank,
        chequeTxnRef: 'TXN-PV-5',
        paymentAmount: '200000',
        bankChargesAmount: '0',
        allocations: [{ payableType: 'PURCHASE_BILL', payableId: billId, amountAllocated: '200000' }],
      },
      actor,
    );
    const posted = await postPayment.execute(id, actor);

    const outstandingBefore = await payableLookup.resolve('PURCHASE_BILL', billId, CO);
    expect(outstandingBefore?.remainingOutstanding.amount.toFixed(4)).toBe('0.0000');

    const before = await ds.query(
      `SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [posted.entryId],
    );

    const cancelled = await cancelPayment.execute(id, 'wrong bill', actor);

    const after = await ds.query(
      `SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [posted.entryId],
    );
    expect(after).toEqual(before); // original byte-for-byte unchanged

    const [rev] = await ds.query(`SELECT id, is_reversal, reversal_of FROM journal_entry WHERE reversal_of=$1`, [posted.entryId]);
    expect(rev.is_reversal).toBe(true);
    expect(cancelled.reversalEntryId).toBe(rev.id);

    const [v] = await ds.query(`SELECT status, entry_no, journal_entry_id FROM payment_voucher WHERE id=$1`, [id]);
    expect(v.status).toBe('CANCELLED');
    expect(v.entry_no).toBe(posted.entryNo); // original number retained
    expect(v.journal_entry_id).toBe(posted.entryId);

    // The allocation drops out of PAY's applied projection -> outstanding restores.
    const outstandingAfter = await payableLookup.resolve('PURCHASE_BILL', billId, CO);
    expect(outstandingAfter?.remainingOutstanding.amount.toFixed(4)).toBe('200000.0000');
  });

  // ── RBAC guard smoke test (skill §13) — proves PaymentController really enforces
  // @UseGuards(JwtAuthGuard, RolesGuard) + @Roles({module:'PAY', action}). ──
  describe('PaymentController RBAC — real RolesGuard against a real Postgres-backed Role/Permission repo', () => {
    const ACCOUNTS_ROLE = '00000000-0000-0000-0000-0000000e2b10';
    const PM_ROLE = '00000000-0000-0000-0000-0000000e2b11';
    const HR_ROLE = '00000000-0000-0000-0000-0000000e2b12';
    const accountsActor: Actor = { ...actor, userId: 'acc-user', role: 'ACCOUNTS_MANAGER' };
    const pmActor: Actor = { ...actor, userId: 'pm-user', role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [PROJECT] };
    const hrActor: Actor = { ...actor, userId: 'hr-user', role: 'HR_MANAGER', isUnscoped: false };

    function mockContext(user: Actor | undefined, requirements: PermissionRequirement[]): ExecutionContext {
      jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requirements);
      return {
        getHandler: () => function handler() {},
        getClass: () => class PaymentController {},
        switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
      } as unknown as ExecutionContext;
    }

    beforeAll(async () => {
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ACCOUNTS_MANAGER',true,1) ON CONFLICT DO NOTHING`, [ACCOUNTS_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1) ON CONFLICT DO NOTHING`, [PM_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'HR_MANAGER',false,1) ON CONFLICT DO NOTHING`, [HR_ROLE, CO]);

      // ACCOUNTS_MANAGER: full PAY lifecycle — per seed-roles-permissions.ts.
      for (const action of ['CREATE', 'READ', 'UPDATE', 'DELETE', 'POST', 'CANCEL']) {
        await ds.query(
          `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'payments.list', $3, 'ALL', 1)`,
          [ACCOUNTS_ROLE, CO, action],
        );
      }
      // HR_MANAGER: PAY:READ only — per seed-roles-permissions.ts.
      await ds.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'payments.list', 'READ', 'ASSIGNED', 1)`,
        [HR_ROLE, CO],
      );
      // PROJECT_MANAGER holds zero PAY grant — the "clearly lacks it" role for 403s.
    });

    it('401: no/invalid token', () => {
      expect(() => jwtAuthGuard.handleRequest(null, false, null)).toThrow(UnauthenticatedError);
      expect(() => jwtAuthGuard.handleRequest(new Error('jwt malformed'), false, null)).toThrow(UnauthenticatedError);
    });

    it.each([
      ['GET /', 'READ'],
      ['GET /:id', 'READ'],
      ['POST /', 'CREATE'],
      ['PATCH /:id', 'UPDATE'],
      ['DELETE /:id', 'DELETE'],
      ['POST /:id/post', 'POST'],
      ['POST /:id/cancel', 'CANCEL'],
      ['POST /:id/repost', 'CANCEL'],
    ] as const)('403: PROJECT_MANAGER (no PAY grant) is FORBIDDEN on %s -> PAY:%s', async (_route, action) => {
      const ctx = mockContext(pmActor, [{ resource: 'payments.list', action }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['GET /', 'READ'],
      ['GET /:id', 'READ'],
      ['POST /', 'CREATE'],
      ['PATCH /:id', 'UPDATE'],
      ['DELETE /:id', 'DELETE'],
      ['POST /:id/post', 'POST'],
      ['POST /:id/cancel', 'CANCEL'],
      ['POST /:id/repost', 'CANCEL'],
    ] as const)('success: ACCOUNTS_MANAGER holds PAY:%s -> guard resolves true (%s)', async (_route, action) => {
      const ctx = mockContext(accountsActor, [{ resource: 'payments.list', action }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('success: HR_MANAGER holds PAY:READ -> guard resolves true', async () => {
      const ctx = mockContext(hrActor, [{ resource: 'payments.list', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('403: HR_MANAGER lacks PAY:POST (HR does not post payments)', async () => {
      const ctx = mockContext(hrActor, [{ resource: 'payments.list', action: 'POST' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403: RolesGuard rejects when request.user is absent even if @Roles() is present (defence-in-depth)', async () => {
      const ctx = mockContext(undefined, [{ resource: 'payments.list', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
