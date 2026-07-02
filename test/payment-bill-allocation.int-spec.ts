/**
 * PAY #28 payment-bill-allocation integration — Testcontainers Postgres, real migrations + LED triggers +
 * the real PostingService + real posted PUR/HR fixtures (SQL). Proves the READ seam that closes the payment
 * loop end-to-end per the brief's DoD:
 *   - AC1: a posted payment allocating 200000 to a 231150 bill → appliedTo('PURCHASE_BILL')=200000,
 *          remaining 31150; open-payables + .../applied reflect it; a DRAFT contributes nothing.
 *   - AC2: cancel → appliedTo=0, remaining back to 231150, with NO UPDATE to purchase_bill (row unchanged).
 *   - AC4: .../applied lists the posted payment; after cancel it is absent.
 *   - AC5: PUR `PurchaseQueryService.outstandingForBill` reflects 31150 (reads PAY through the rebound port).
 *   - AC6: labour + salary settled via the projection reflect a posted payment and drop to 0 on cancel.
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
import { PaymentAllocationReadModel } from '../src/modules/payment/infrastructure/payment-allocation.read-model';
import { PayableSettlementAdapter } from '../src/modules/payment/infrastructure/payable-settlement.adapter';
import { PaymentQueryService } from '../src/modules/payment/application/payment-query.service';
import { CreatePaymentUseCase } from '../src/modules/payment/application/create-payment.usecase';
import { PostPaymentUseCase } from '../src/modules/payment/application/post-payment.usecase';
import { CancelPaymentUseCase } from '../src/modules/payment/application/cancel-payment.usecase';

import { PurchaseQueryService } from '../src/modules/purchase/application/purchase-query.service';
import { PurchaseRegisterReadRepo } from '../src/modules/purchase/infrastructure/purchase-register.read.repo';
import { PaymentBackedBillPaymentAdapter } from '../src/modules/purchase/infrastructure/payment-backed-bill-payment.adapter';
import { HrQueryService } from '../src/modules/hr/application/hr-query.service';

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
  ap: '00000000-0000-0000-0000-00000000a100',
  labourPayable: '00000000-0000-0000-0000-00000000a231',
  salaryPayable: '00000000-0000-0000-0000-00000000a230',
  labourCost: '00000000-0000-0000-0000-00000000a511',
  bankCharges: '00000000-0000-0000-0000-00000000a620',
  cash: '00000000-0000-0000-0000-00000000a110',
  bank: '00000000-0000-0000-0000-00000000a111',
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

describe('PAY #28 payment-bill-allocation (real Postgres + PostingService + PUR/HR read seam)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let createPayment: CreatePaymentUseCase;
  let postPayment: PostPaymentUseCase;
  let cancelPayment: CancelPaymentUseCase;
  let readModel: PaymentAllocationReadModel;
  let settlement: PayableSettlementAdapter;
  let paymentQuery: PaymentQueryService;
  let purchaseQuery: PurchaseQueryService;
  let hrQuery: HrQueryService;

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
    const payableLookup = new PayableLookupAdapter(ds);
    const accountMap = new PaymentAccountMapAdapter(ds);
    const audit = { record: async () => undefined };

    createPayment = new CreatePaymentUseCase(repo, payableLookup, audit as never, uow, ids);
    postPayment = new PostPaymentUseCase(repo, payableLookup, accountMap, posting, audit as never, uow, clock);
    cancelPayment = new CancelPaymentUseCase(repo, posting, audit as never, uow);

    readModel = new PaymentAllocationReadModel(ds);
    settlement = new PayableSettlementAdapter(readModel);
    paymentQuery = new PaymentQueryService(ds, readModel);
    purchaseQuery = new PurchaseQueryService(ds, new PaymentBackedBillPaymentAdapter(settlement), new PurchaseRegisterReadRepo(ds));
    hrQuery = new HrQueryService(ds, settlement);
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

  async function createPurchaseBill(seq: number, net: string): Promise<string> {
    const id = `00000000-0000-0000-0000-0000000b${String(seq).padStart(4, '0')}`;
    await ds.query(
      `INSERT INTO purchase_bill (id, company_id, financial_year_id, project_id, supplier_id, bill_date, due_date, gross_amount, net_payable_amount, status)
       VALUES ($1,$2,$3,$4,$5,'2026-06-15','2026-07-15',$6,$6,'POSTED')`,
      [id, CO, FY1, PROJECT, SUPPLIER, net],
    );
    return id;
  }

  async function createLabourPayable(seq: number, accrued: string): Promise<string> {
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

  async function createSalarySheet(seq: number, net: string): Promise<string> {
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

  it('AC1: posted payment reduces the projection; a DRAFT contributes nothing; open-payables + applied reflect it', async () => {
    const billId = await createPurchaseBill(1, '231150');

    // A DRAFT payment contributes nothing (AC1 precondition).
    const draft = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'CASH',
        paymentAccountId: ACC.cash,
        paymentAmount: '200000',
        bankChargesAmount: '0',
        allocations: [{ payableType: 'PURCHASE_BILL', payableId: billId, amountAllocated: '200000' }],
      },
      actor,
    );
    expect((await settlement.appliedTo('PURCHASE_BILL', billId, CO)).toFixed(4)).toBe('0.0000');

    await postPayment.execute(draft.id, actor);

    // Projection: applied 200000, remaining 31150.
    expect((await settlement.appliedTo('PURCHASE_BILL', billId, CO)).toFixed(4)).toBe('200000.0000');
    const applied = await paymentQuery.appliedToPayable('PURCHASE_BILL', billId, actor);
    expect(applied).toMatchObject({
      originalAmount: '231150.0000',
      appliedAmount: '200000.0000',
      remainingOutstanding: '31150.0000',
    });

    // open-payables: the bill appears once with remaining 31150.
    const open = await paymentQuery.openPayables({ payableType: 'PURCHASE_BILL' }, actor);
    expect(open.total).toBe(1);
    expect(open.items[0]).toMatchObject({
      payableId: billId,
      originalAmount: '231150.0000',
      appliedAmount: '200000.0000',
      remainingOutstanding: '31150.0000',
    });

    // AC4: the applications trail lists the posted payment.
    expect(applied.applications).toHaveLength(1);
    expect(applied.applications[0]).toMatchObject({ paymentId: draft.id, amountAllocated: '200000.0000', status: 'POSTED' });
  });

  it('AC2 + AC4: cancel restores the projection with NO UPDATE to purchase_bill; applications drop out', async () => {
    const billId = await createPurchaseBill(2, '231150');
    const before = await ds.query(`SELECT * FROM purchase_bill WHERE id=$1`, [billId]);

    const draft = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'CASH',
        paymentAccountId: ACC.cash,
        paymentAmount: '200000',
        bankChargesAmount: '0',
        allocations: [{ payableType: 'PURCHASE_BILL', payableId: billId, amountAllocated: '200000' }],
      },
      actor,
    );
    await postPayment.execute(draft.id, actor);
    expect((await settlement.appliedTo('PURCHASE_BILL', billId, CO)).toFixed(4)).toBe('200000.0000');

    await cancelPayment.execute(draft.id, 'wrong bill', actor);

    // Projection resets; applications empty.
    expect((await settlement.appliedTo('PURCHASE_BILL', billId, CO)).toFixed(4)).toBe('0.0000');
    const applied = await paymentQuery.appliedToPayable('PURCHASE_BILL', billId, actor);
    expect(applied.remainingOutstanding).toBe('231150.0000');
    expect(applied.applications).toHaveLength(0);

    // AC2: purchase_bill row byte-for-byte unchanged (read seam never writes to PUR).
    const after = await ds.query(`SELECT * FROM purchase_bill WHERE id=$1`, [billId]);
    expect(after).toEqual(before);
  });

  it('AC5: PUR outstandingForBill reads PAY through the rebound port (231150 → 31150 after payment)', async () => {
    const billId = await createPurchaseBill(3, '231150');
    expect(await purchaseQuery.outstandingForBill(billId, actor)).toBe('231150.0000');

    const draft = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'CASH',
        paymentAccountId: ACC.cash,
        paymentAmount: '200000',
        bankChargesAmount: '0',
        allocations: [{ payableType: 'PURCHASE_BILL', payableId: billId, amountAllocated: '200000' }],
      },
      actor,
    );
    await postPayment.execute(draft.id, actor);

    expect(await purchaseQuery.outstandingForBill(billId, actor)).toBe('31150.0000');
  });

  it('AC6: labour payable settled via the projection reflects a posted payment and drops on cancel', async () => {
    const lpId = await createLabourPayable(4, '50000');
    expect((await hrQuery.labourPayableSettled(lpId, actor))).toMatchObject({
      accruedAmount: '50000.0000',
      settledAmount: '0.0000',
      remainingOutstanding: '50000.0000',
      status: 'OUTSTANDING',
    });

    const draft = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'CASH',
        paymentAccountId: ACC.cash,
        paymentAmount: '50000',
        bankChargesAmount: '0',
        allocations: [{ payableType: 'LABOUR_PAYABLE', payableId: lpId, amountAllocated: '50000' }],
      },
      actor,
    );
    await postPayment.execute(draft.id, actor);
    expect(await hrQuery.labourPayableSettled(lpId, actor)).toMatchObject({
      settledAmount: '50000.0000',
      remainingOutstanding: '0.0000',
      status: 'SETTLED',
    });

    await cancelPayment.execute(draft.id, 'reversed', actor);
    expect(await hrQuery.labourPayableSettled(lpId, actor)).toMatchObject({
      settledAmount: '0.0000',
      remainingOutstanding: '50000.0000',
      status: 'OUTSTANDING',
    });
  });

  it('AC6: salary sheet settled via the projection reflects a posted payment and drops on cancel', async () => {
    const sheetId = await createSalarySheet(5, '480000');
    expect(await hrQuery.salarySheetSettled(sheetId, actor)).toMatchObject({
      accruedAmount: '480000.0000',
      settledAmount: '0.0000',
      remainingOutstanding: '480000.0000',
      status: 'OUTSTANDING',
    });

    const draft = await createPayment.execute(
      {
        paymentDate: '2026-06-30',
        paymentMode: 'CHEQUE',
        paymentAccountId: ACC.bank,
        chequeTxnRef: 'CHQ-5',
        paymentAmount: '480000',
        bankChargesAmount: '0',
        allocations: [{ payableType: 'SALARY', payableId: sheetId, amountAllocated: '480000' }],
      },
      actor,
    );
    await postPayment.execute(draft.id, actor);
    expect(await hrQuery.salarySheetSettled(sheetId, actor)).toMatchObject({
      settledAmount: '480000.0000',
      remainingOutstanding: '0.0000',
      status: 'SETTLED',
    });

    await cancelPayment.execute(draft.id, 'reversed', actor);
    expect(await hrQuery.salarySheetSettled(sheetId, actor)).toMatchObject({
      settledAmount: '0.0000',
      remainingOutstanding: '480000.0000',
      status: 'OUTSTANDING',
    });
  });
});
