/**
 * PUR GRN + three-way match + supplier register integration — Testcontainers Postgres, real migrations
 * (incl. 1700002100000-CreatePurchaseGrn), the real #25 bill use cases (real INV/LED/NUM/PER/CC), and the
 * real GRN use cases. Mirrors test/purchase-bill.int-spec.ts's bootstrap. Proves the brief's DoD under the
 * RESOLVED §10 Q4 option (a) — "received = billed at bill post"; the GRN is informational:
 *   - THE DOUBLE-COUNT GUARD (AC1/AC4/AC5 in their option-(a) form): posting a GRN of 90 against a billed
 *     100 writes ZERO stock_movement rows, ZERO journal_entry/journal_line rows, consumes ZERO numbers,
 *     and leaves the previously-posted bill's stock-ledger ⇄ GL reconciliation BYTE-IDENTICAL;
 *   - AC2/AC8: the match view — UNDER_RECEIVED/openQty 10 after the 90-receipt; PENDING_RECEIPT on an
 *     unbilled/unreceived PO line; computed over PO/bill/GRN records, never stored;
 *   - AC3: two partial GRNs 60+40 -> MATCHED, openQty 0;
 *   - AC6: over-delivery 110 of 100 -> OVER_RECEIVED, recorded, NOT blocked, no stock effect;
 *   - AC7/AC9: supplier/project register rows + totals reconcile to journal_line party+AP(2100), with
 *     paid=0 / outstanding=netPayable via the Phase-1 BillPaymentReadPort seam (PAY -> brief #28);
 *   - AC11: DRAFT-only lifecycle (double-post 409), cancel = status flip only, PM scoping;
 *   - the RBAC guard smoke test (skill §13) incl. the NEW seeded STORE_KEEPER PUR:CREATE/READ/POST grant.
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
import { ProjectOrmEntity } from '../src/modules/master-data/project/infrastructure/project.orm-entity';
import { CostCentreOrmEntity } from '../src/modules/master-data/cost-centre/infrastructure/cost-centre.orm-entity';
import { PurposeOrmEntity } from '../src/modules/master-data/purpose/infrastructure/purpose.orm-entity';
import { GodownOrmEntity } from '../src/modules/master-data/godown/infrastructure/godown.orm-entity';
import { ItemOrmEntity } from '../src/modules/master-data/item/infrastructure/item.orm-entity';
import { StockMovementOrmEntity } from '../src/modules/inventory/infrastructure/stock-movement.orm-entity';
import { StockBalanceOrmEntity } from '../src/modules/inventory/infrastructure/stock-balance.orm-entity';
import { PurchaseOrderOrmEntity } from '../src/modules/purchase/infrastructure/purchase-order.orm-entity';
import { PurchaseOrderLineOrmEntity } from '../src/modules/purchase/infrastructure/purchase-order-line.orm-entity';
import { PurchaseBillOrmEntity } from '../src/modules/purchase/infrastructure/purchase-bill.orm-entity';
import { PurchaseBillLineOrmEntity } from '../src/modules/purchase/infrastructure/purchase-bill-line.orm-entity';
import { GrnOrmEntity } from '../src/modules/purchase/infrastructure/grn.orm-entity';
import { GrnLineOrmEntity } from '../src/modules/purchase/infrastructure/grn-line.orm-entity';

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
import { CreateStockMovementAndBalance1700001000000 } from '../src/database/migrations/1700001000000-CreateStockMovementAndBalance';
import { CreateStockJournal1700001500000 } from '../src/database/migrations/1700001500000-CreateStockJournal';
import { CreatePurchasePoBill1700002000000 } from '../src/database/migrations/1700002000000-CreatePurchasePoBill';
import { CreatePurchaseGrn1700002100000 } from '../src/database/migrations/1700002100000-CreatePurchaseGrn';

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
import { AccessPolicy } from '../src/core/auth/domain/access-policy';

import { TypeOrmStockMovementRepository } from '../src/modules/inventory/infrastructure/typeorm-stock-movement.repository';
import { InventoryAccountResolverAdapter } from '../src/modules/inventory/infrastructure/inventory-account-resolver.adapter';
import { InventoryServiceAdapter } from '../src/modules/inventory/application/inventory.service';
import { StockLedgerQueryService } from '../src/modules/inventory/application/stock-ledger-query.service';

import { TagConsistencyServiceImpl } from '../src/core/cost-control/application/tag-consistency.service';
import { BudgetCheckServiceImpl } from '../src/core/cost-control/application/budget-check.service';
import { TypeOrmCostControlReadRepository } from '../src/core/cost-control/infrastructure/typeorm-cost-control.read.repo';

import { TypeOrmPurchaseOrderRepository } from '../src/modules/purchase/infrastructure/typeorm-purchase-order.repository';
import { TypeOrmPurchaseBillRepository } from '../src/modules/purchase/infrastructure/typeorm-purchase-bill.repository';
import { TypeOrmGrnRepository } from '../src/modules/purchase/infrastructure/typeorm-grn.repository';
import { PurchaseAccountMapAdapter } from '../src/modules/purchase/infrastructure/purchase-account-map.adapter';
import { PurchaseConfigAdapter } from '../src/modules/purchase/infrastructure/purchase-config.adapter';
import { PurchaseProjectStatusAdapter } from '../src/modules/purchase/infrastructure/purchase-project-status.adapter';
import { PurchaseRegisterReadRepo } from '../src/modules/purchase/infrastructure/purchase-register.read.repo';
import { ZeroBillPaymentReadAdapter } from '../src/modules/purchase/infrastructure/bill-payment.read.adapter';
import { CreatePurchaseOrderUseCase } from '../src/modules/purchase/application/create-purchase-order.usecase';
import { ApprovePurchaseOrderUseCase } from '../src/modules/purchase/application/approve-purchase-order.usecase';
import { CreatePurchaseBillUseCase } from '../src/modules/purchase/application/create-purchase-bill.usecase';
import { PostPurchaseBillUseCase } from '../src/modules/purchase/application/post-purchase-bill.usecase';
import { CreateGrnUseCase, NewGrnInput } from '../src/modules/purchase/application/create-grn.usecase';
import { PostGrnUseCase } from '../src/modules/purchase/application/post-grn.usecase';
import { CancelGrnUseCase } from '../src/modules/purchase/application/cancel-grn.usecase';
import { PurchaseQueryService } from '../src/modules/purchase/application/purchase-query.service';
import { NewPurchaseBill } from '../src/modules/purchase/domain/purchase-bill';

// RolesGuard smoke test deps (mandatory per skill §13).
import { ExecutionContext, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { JwtAuthGuard } from '../src/core/auth/presentation/jwt-auth.guard';
import { PermissionRequirement } from '../src/core/auth/presentation/require-permission.decorator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c8';
const FY1 = '00000000-0000-0000-0000-0000000000f8';
const PERIOD = '00000000-0000-0000-0000-0000000000e8';
const USER = '00000000-0000-0000-0000-0000000000a8';
const SUPPLIER = '00000000-0000-0000-0000-0000000000b8';
const CUSTOMER = '00000000-0000-0000-0000-0000000000b9';
const PROJECT = '00000000-0000-0000-0000-00000000d801';
const OTHER_PROJECT = '00000000-0000-0000-0000-00000000d8aa';
const CC = '00000000-0000-0000-0000-00000000d802';
const PURPOSE = '00000000-0000-0000-0000-00000000d803';
const GODOWN = '00000000-0000-0000-0000-00000000d804';
const ITEM_CEMENT = '00000000-0000-0000-0000-00000000d805';
const ITEM_ROD = '00000000-0000-0000-0000-00000000d806';

const GROUP = '00000000-0000-0000-0000-00000000a800';
const ACCT_INV = '00000000-0000-0000-0000-00000000a805';
const ACCT_VAT_INPUT = '00000000-0000-0000-0000-00000000a810';
const ACCT_AP = '00000000-0000-0000-0000-00000000a811';
const ACCT_TDS = '00000000-0000-0000-0000-00000000a812';
const ACCT_AIT = '00000000-0000-0000-0000-00000000a813';

const actor: Actor = {
  userId: USER,
  companyId: CO,
  financialYearId: FY1,
  role: 'AccountsTeam',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

describe('PUR GRN + match + registers (real Postgres; §10 Q4 option (a) — informational GRN)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let uow: TypeOrmUnitOfWork;
  let createPo: CreatePurchaseOrderUseCase;
  let approvePo: ApprovePurchaseOrderUseCase;
  let createBill: CreatePurchaseBillUseCase;
  let postBill: PostPurchaseBillUseCase;
  let createGrn: CreateGrnUseCase;
  let postGrn: PostGrnUseCase;
  let cancelGrn: CancelGrnUseCase;
  let query: PurchaseQueryService;
  let registerRepo: PurchaseRegisterReadRepo;
  let ledgerQuery: StockLedgerQueryService;
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
        ProjectOrmEntity,
        CostCentreOrmEntity,
        PurposeOrmEntity,
        GodownOrmEntity,
        ItemOrmEntity,
        StockMovementOrmEntity,
        StockBalanceOrmEntity,
        PurchaseOrderOrmEntity,
        PurchaseOrderLineOrmEntity,
        PurchaseBillOrmEntity,
        PurchaseBillLineOrmEntity,
        GrnOrmEntity,
        GrnLineOrmEntity,
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
        CreateStockMovementAndBalance1700001000000,
        CreateStockJournal1700001500000,
        CreatePurchasePoBill1700002000000,
        CreatePurchaseGrn1700002100000,
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
      `INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES ($1,$2,$3,'FY2526','2025-07-01','2027-06-30','OPEN')`,
      [PERIOD, CO, FY1],
    );
    await ds.query(`INSERT INTO account_group (id, company_id, name, type) VALUES ($1,$2,'Current Assets','ASSET')`, [GROUP, CO]);
    await ds.query(
      `INSERT INTO account (id, company_id, code, name, account_group_id, type, is_active) VALUES
         ($1,$2,'1300','Inventory',$3,'ASSET',true),
         ($4,$2,'1230','VAT Input (Recoverable)',$3,'ASSET',true),
         ($5,$2,'2100','Accounts Payable',$3,'LIABILITY',true),
         ($6,$2,'2210','TDS Payable',$3,'LIABILITY',true),
         ($7,$2,'2220','AIT Payable',$3,'LIABILITY',true)`,
      [ACCT_INV, CO, GROUP, ACCT_VAT_INPUT, ACCT_AP, ACCT_TDS, ACCT_AIT],
    );
    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES
         ($1,$2,'Supp X',false,true,'+8801700000000'),
         ($3,$2,'Cust A',true,false,'+8801700000001')`,
      [SUPPLIER, CO, CUSTOMER],
    );
    const project = (id: string, code: string) =>
      ds.query(
        `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,$3,$3,$4,$5,'2025-07-01','2026-06-30','ACTIVE')`,
        [id, CO, code, CUSTOMER, USER],
      );
    await project(PROJECT, 'P-01');
    await project(OTHER_PROJECT, 'P-02');
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Slab','Slab')`, [CC, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Day 20 pour')`, [PURPOSE, CO, PROJECT]);
    await ds.query(`INSERT INTO godown (id, company_id, project_id, name, is_active) VALUES ($1,$2,$3,'G-Site-A',true)`, [
      GODOWN,
      CO,
      PROJECT,
    ]);
    await ds.query(
      `INSERT INTO item (id, company_id, code, name, base_uom, default_account_id, is_active) VALUES
         ($1,$2,'CEM','Cement','BAG',$3,true),($4,$2,'ROD','Rod','KG',$3,true)`,
      [ITEM_CEMENT, CO, ACCT_INV, ITEM_ROD],
    );

    const ids = new UuidIdGenerator();
    uow = new TypeOrmUnitOfWork(ds);
    const clock = { now: () => new Date('2026-06-29T10:00:00Z') };
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

    const movementRepo = new TypeOrmStockMovementRepository(ds, ids);
    const inventoryService = new InventoryServiceAdapter(movementRepo, ids, clock);
    const inventoryAccounts = new InventoryAccountResolverAdapter(ds);
    ledgerQuery = new StockLedgerQueryService(ds);

    const ccRepo = new TypeOrmCostControlReadRepository(ds);
    const tagConsistency = new TagConsistencyServiceImpl(ccRepo);
    const budgetCheck = new BudgetCheckServiceImpl(ccRepo);

    const poRepo = new TypeOrmPurchaseOrderRepository(ds);
    const billRepo = new TypeOrmPurchaseBillRepository(ds);
    const grnRepo = new TypeOrmGrnRepository(ds);
    const accountMap = new PurchaseAccountMapAdapter(ds, inventoryAccounts);
    const config = new PurchaseConfigAdapter();
    const projectStatus = new PurchaseProjectStatusAdapter(ds);
    const access = new AccessPolicy();
    const audit = { record: async () => undefined };

    createPo = new CreatePurchaseOrderUseCase(poRepo, tagConsistency, budgetCheck, access, audit as never, uow, ids);
    approvePo = new ApprovePurchaseOrderUseCase(poRepo, audit as never, uow, clock);
    createBill = new CreatePurchaseBillUseCase(billRepo, poRepo, config, tagConsistency, budgetCheck, access, audit as never, uow, ids);
    postBill = new PostPurchaseBillUseCase(billRepo, poRepo, accountMap, projectStatus, inventoryService, budgetCheck, posting, audit as never, uow, clock);
    createGrn = new CreateGrnUseCase(grnRepo, billRepo, poRepo, tagConsistency, access, audit as never, uow, ids);
    postGrn = new PostGrnUseCase(grnRepo, billRepo, audit as never, uow, clock);
    cancelGrn = new CancelGrnUseCase(grnRepo, audit as never, uow);
    registerRepo = new PurchaseRegisterReadRepo(ds);
    query = new PurchaseQueryService(ds, new ZeroBillPaymentReadAdapter(), registerRepo);

    const roleRepo = new TypeOrmRoleRepository(ds);
    const permRepo = new TypeOrmPermissionRepository(ds);
    rolesGuard = new RolesGuard(new Reflector(), roleRepo, permRepo);
    jwtAuthGuard = new JwtAuthGuard();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await ds.query(
      'TRUNCATE grn_line, grn, purchase_bill_line, purchase_bill, purchase_order_line, purchase_order, journal_line, journal_entry, stock_movement, stock_balance, numbering_series RESTART IDENTITY CASCADE',
    );
  });

  // ---- fixtures -------------------------------------------------------------------------------------

  function billInput(overrides: Partial<NewPurchaseBill> = {}): NewPurchaseBill {
    return {
      projectId: PROJECT,
      supplierId: SUPPLIER,
      billDate: '2026-06-29',
      dueDate: '2026-07-29',
      supplierInvoiceRef: 'INV-7741',
      lines: [
        {
          itemId: ITEM_CEMENT,
          isStockLine: true,
          billedQty: '100',
          rate: '500',
          godownId: GODOWN,
          projectId: PROJECT,
          costCentreId: CC,
          purposeId: PURPOSE,
        },
      ],
      ...overrides,
    };
  }

  /** Create + post a bill; returns { billId, billLines: [{id,item_id,billed_qty}] }. */
  async function postedBill(overrides: Partial<NewPurchaseBill> = {}): Promise<{
    billId: string;
    billLines: Array<{ id: string; item_id: string }>;
  }> {
    const { id } = await createBill.execute(billInput(overrides), actor);
    await postBill.execute(id, actor);
    const billLines = (await ds.query(
      `SELECT id, item_id FROM purchase_bill_line WHERE purchase_bill_id=$1 ORDER BY line_no`,
      [id],
    )) as Array<{ id: string; item_id: string }>;
    return { billId: id, billLines };
  }

  function grnInput(billId: string, billLineId: string, qty: string, overrides: Partial<NewGrnInput> = {}): NewGrnInput {
    return {
      projectId: PROJECT,
      supplierId: SUPPLIER,
      purchaseBillId: billId,
      receiptDate: '2026-06-29',
      grnRefNo: 'GRN-2026-0301',
      lines: [
        {
          purchaseBillLineId: billLineId,
          itemId: ITEM_CEMENT,
          receivedQty: qty,
          rate: '500',
          godownId: GODOWN,
          costCentreId: CC,
          purposeId: PURPOSE,
        },
      ],
      ...overrides,
    };
  }

  /** Full byte-level snapshot of every table a GRN post must NOT touch (the option-(a) invariant). */
  async function ledgerAndStockSnapshot(): Promise<Record<string, unknown>> {
    return {
      movements: await ds.query(`SELECT * FROM stock_movement ORDER BY id`),
      balances: await ds.query(`SELECT * FROM stock_balance ORDER BY godown_id, item_id`),
      entries: await ds.query(`SELECT * FROM journal_entry ORDER BY id`),
      journalLines: await ds.query(`SELECT * FROM journal_line ORDER BY journal_entry_id, line_no`),
      numbering: await ds.query(`SELECT * FROM numbering_series ORDER BY id`),
    };
  }

  /** Σ stock-ledger value and the inventory GL balance — the FR-INV-005 reconciliation pair. */
  async function reconciliation(): Promise<{ stock: string; gl: string }> {
    const ledger = await ledgerQuery.stockLedger({}, actor);
    const stock = ledger.items.reduce((s, r) => s.plus(new Decimal(r.totalValue)), new Decimal(0)).toFixed(4);
    const [{ bal }] = await ds.query(
      `SELECT COALESCE(SUM(debit - credit),0)::numeric(18,4)::text AS bal FROM journal_line WHERE account_id = $1`,
      [ACCT_INV],
    );
    return { stock, gl: bal };
  }

  // ── THE DOUBLE-COUNT GUARD — AC1/AC4/AC5 in their option-(a) form ──────────────────────────────────────

  it('DOUBLE-COUNT GUARD: posting a GRN of 90 against billed 100 writes ZERO movements/entries, consumes ZERO numbers, and leaves the stock⇄GL reconciliation BYTE-IDENTICAL', async () => {
    const { billId, billLines } = await postedBill();

    // The bill (#25) rolled 100 bags -> 50,000 into stock; reconciliation holds.
    const before = await ledgerAndStockSnapshot();
    const reconBefore = await reconciliation();
    expect(reconBefore.stock).toBe('50000.0000');
    expect(reconBefore.gl).toBe('50000.0000');
    expect((before.movements as unknown[]).length).toBe(1);
    expect((before.entries as unknown[]).length).toBe(1);

    // Post the GRN — physically received 90 of the billed 100.
    const { id: grnId } = await createGrn.execute(grnInput(billId, billLines[0].id, '90'), actor);
    const res = await postGrn.execute(grnId, actor);
    expect(res.status).toBe('POSTED');
    expect(res.lines).toEqual([{ lineNo: 1, matchStatus: 'UNDER_RECEIVED' }]);

    // POSITIVE ASSERTIONS (option (a)): zero new stock_movement, zero new journal_entry/line, zero
    // numbering consumption, stock balances untouched — byte-identical, not merely "same count".
    const after = await ledgerAndStockSnapshot();
    expect(after).toEqual(before);
    const reconAfter = await reconciliation();
    expect(reconAfter).toEqual(reconBefore); // Σ stock-ledger value still = inventory GL balance, unchanged

    // The GRN itself is recorded and informational.
    const dto = await query.getGrn(grnId, actor);
    expect(dto!.status).toBe('POSTED');
    expect(dto!.lines[0].matchStatus).toBe('UNDER_RECEIVED');
    expect(dto!.lines[0].receivedValue).toBe('45000.0000'); // 90 x 500 — recorded, NOT posted anywhere

    // Derived bill-line read: receivedQty 90, UNDER_RECEIVED (a query over POSTED GRNs, FR-PUR-017).
    const billDto = await query.getBill(billId, actor);
    expect(billDto!.lines[0].receivedQty).toBe('90.0000');
    expect(billDto!.lines[0].matchStatus).toBe('UNDER_RECEIVED');
  });

  // ── AC2/AC8 — the three-way match view over a PO ────────────────────────────────────────────────────────

  it('AC2/AC8: PO match view — billed line UNDER_RECEIVED/openQty 10 after a 90-receipt; unbilled PO line PENDING_RECEIPT; all computed, never stored', async () => {
    const { id: poId } = await createPo.execute(
      {
        projectId: PROJECT,
        supplierId: SUPPLIER,
        poRefNo: 'PO-2026-0188',
        poDate: '2026-06-20',
        expectedDeliveryDate: '2026-06-28',
        lines: [
          { itemId: ITEM_CEMENT, orderedQty: '100', rate: '500', godownId: GODOWN, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE },
          { itemId: ITEM_ROD, orderedQty: '2', rate: '90000', godownId: GODOWN, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE },
        ],
      },
      actor,
    );
    await approvePo.execute(poId, actor);

    // Bill ONLY the cement line against the PO (the rod line stays unbilled).
    const { billId, billLines } = await postedBill({ purchaseOrderId: poId });

    let match = await query.poMatch(poId, actor);
    expect(match.poId).toBe(poId);
    expect(match.lines).toHaveLength(2);
    const cement = match.lines.find((l) => l.itemId === ITEM_CEMENT)!;
    expect(cement).toMatchObject({
      orderedQty: '100.0000',
      billedQty: '100.0000',
      receivedQty: '0.0000',
      openQty: '100.0000',
      matchStatus: 'PENDING_RECEIPT', // billed, nothing physically received yet
    });
    const rod = match.lines.find((l) => l.itemId === ITEM_ROD)!;
    expect(rod).toMatchObject({
      orderedQty: '2.0000',
      billedQty: '0.0000',
      receivedQty: '0.0000',
      openQty: '0.0000',
      matchStatus: 'PENDING_RECEIPT', // unbilled + unreceived (AC8)
    });

    // Receive 90 of the billed 100 -> UNDER_RECEIVED, openQty 10 (AC2).
    const { id: grnId } = await createGrn.execute(grnInput(billId, billLines[0].id, '90', { purchaseOrderId: poId }), actor);
    await postGrn.execute(grnId, actor);

    match = await query.poMatch(poId, actor);
    expect(match.lines.find((l) => l.itemId === ITEM_CEMENT)).toMatchObject({
      billedQty: '100.0000',
      receivedQty: '90.0000',
      openQty: '10.0000',
      matchStatus: 'UNDER_RECEIVED',
    });
  });

  // ── AC3 — partial receipt 60 + 40 ───────────────────────────────────────────────────────────────────────

  it('AC3: two partial GRNs (60 then 40) against billed 100 -> Σ received 100, openQty 0, MATCHED', async () => {
    const { billId, billLines } = await postedBill();
    const lineId = billLines[0].id;

    const g1 = await createGrn.execute(grnInput(billId, lineId, '60'), actor);
    const r1 = await postGrn.execute(g1.id, actor);
    expect(r1.lines[0].matchStatus).toBe('UNDER_RECEIVED'); // 60 of 100

    let billDto = await query.getBill(billId, actor);
    expect(billDto!.lines[0].receivedQty).toBe('60.0000');

    // The second draft DEFAULTS its line from the bill's open quantity: 100 − 60 = 40 (FR-PUR-018).
    const g2 = await createGrn.execute(grnInput(billId, lineId, 'ignored', { lines: undefined }), actor);
    const g2dto = await query.getGrn(g2.id, actor);
    expect(g2dto!.lines).toHaveLength(1);
    expect(g2dto!.lines[0].receivedQty).toBe('40.0000');
    expect(g2dto!.lines[0].purchaseBillLineId).toBe(lineId);

    const r2 = await postGrn.execute(g2.id, actor);
    expect(r2.lines[0].matchStatus).toBe('MATCHED'); // 60 + 40 = 100

    billDto = await query.getBill(billId, actor);
    expect(billDto!.lines[0].receivedQty).toBe('100.0000');
    expect(billDto!.lines[0].matchStatus).toBe('MATCHED');
  });

  // ── AC6 — over-delivery ─────────────────────────────────────────────────────────────────────────────────

  it('AC6: over-delivery 110 of billed 100 -> recorded OVER_RECEIVED, NOT blocked; bill payable unchanged; no stock effect from the GRN', async () => {
    const { billId, billLines } = await postedBill();
    const before = await ledgerAndStockSnapshot();

    const { id: grnId } = await createGrn.execute(grnInput(billId, billLines[0].id, '110'), actor);
    const res = await postGrn.execute(grnId, actor); // NOT blocked (advisory — edge case 6)
    expect(res.status).toBe('POSTED');
    expect(res.lines[0].matchStatus).toBe('OVER_RECEIVED');

    const billDto = await query.getBill(billId, actor);
    expect(billDto!.netPayableAmount).toBe('50250.0000'); // 50,000 + 7.5% VAT − 5% TDS − 2% AIT — unchanged
    expect(billDto!.lines[0].receivedQty).toBe('110.0000');
    expect(billDto!.lines[0].matchStatus).toBe('OVER_RECEIVED');

    expect(await ledgerAndStockSnapshot()).toEqual(before); // option (a): the GRN moved nothing
  });

  // ── AC7/AC9 — supplier & project registers reconcile to the ledger ─────────────────────────────────────

  it('AC7/AC9: supplier register rows + totals reconcile to journal_line party+AP(2100); paid=0, outstanding=netPayable via the Phase-1 PAY seam', async () => {
    const bill1 = await postedBill(); // cement 100 x 500
    const bill2 = await postedBill({
      supplierInvoiceRef: 'INV-7742',
      lines: [
        { itemId: ITEM_ROD, isStockLine: true, billedQty: '2', rate: '90000', godownId: GODOWN, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE },
      ],
    });
    // A DRAFT bill must NOT appear in the register (posted vouchers only).
    await createBill.execute(billInput({ supplierInvoiceRef: 'INV-DRAFT' }), actor);

    const reg = await query.supplierRegister(SUPPLIER, actor);
    expect(reg.rows).toHaveLength(2);
    const row1 = reg.rows.find((r) => r.billId === bill1.billId)!;
    expect(row1).toMatchObject({
      grossAmount: '50000.0000',
      vatInputAmount: '3750.0000', // 7.5%
      tdsAmount: '2500.0000', // 5%
      aitAmount: '1000.0000', // 2%
      netPayableAmount: '50250.0000',
      paidAmount: '0.0000', // PAY seam — ZeroBillPaymentReadAdapter until brief #28
      outstandingAmount: '50250.0000', // = netPayable while nothing is applied (FR-PUR-020)
    });
    const row2 = reg.rows.find((r) => r.billId === bill2.billId)!;
    expect(row2.netPayableAmount).toBe('180900.0000'); // 180,000 + 13,500 − 9,000 − 3,600
    expect(row2.outstandingAmount).toBe('180900.0000');

    expect(reg.totals).toEqual({
      grossAmount: '230000.0000',
      vatInputAmount: '17250.0000',
      tdsAmount: '11500.0000',
      aitAmount: '4600.0000',
      netPayableAmount: '231150.0000',
      paidAmount: '0.0000',
      outstandingAmount: '231150.0000',
    });

    // RECONCILIATION (FR-PUR-021): Σ net payable = the party's AP(2100) balance in journal_line.
    const apBalance = await registerRepo.supplierApBalance(SUPPLIER, CO);
    expect(apBalance.toFixed(4)).toBe(reg.totals.netPayableAmount);

    // Per-bill outstanding is independent per INDIVIDUAL bill (AC7).
    expect(await query.outstandingForBill(bill1.billId, actor)).toBe('50250.0000');
    expect(await query.outstandingForBill(bill2.billId, actor)).toBe('180900.0000');

    // The project register returns the same figures scoped by project (FR-PUR-021).
    const projReg = await query.projectPurchaseRegister(PROJECT, actor);
    expect(projReg.totals.netPayableAmount).toBe('231150.0000');
    expect(projReg.rows).toHaveLength(2);

    // Unknown supplier -> 404.
    await expect(query.supplierRegister(OTHER_PROJECT /* not a party id */, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── AC11 — DRAFT-only lifecycle, cancel = status flip, PM scoping ───────────────────────────────────────

  it('AC11: a POSTED GRN rejects a second post (409 VOUCHER_POSTED_IMMUTABLE); cancel is a status flip that drops it out of Σ received; a DRAFT cancel is rejected', async () => {
    const { billId, billLines } = await postedBill();
    const { id: grnId } = await createGrn.execute(grnInput(billId, billLines[0].id, '90'), actor);

    // Cancel of a DRAFT -> VOUCHER_NOT_POSTED.
    await expect(cancelGrn.execute(grnId, 'nope', actor)).rejects.toMatchObject({ code: 'VOUCHER_NOT_POSTED' });

    await postGrn.execute(grnId, actor);
    await expect(postGrn.execute(grnId, actor)).rejects.toMatchObject({ code: 'VOUCHER_POSTED_IMMUTABLE' });

    const before = await ledgerAndStockSnapshot();
    const res = await cancelGrn.execute(grnId, 'recorded against the wrong bill', actor);
    expect(res.status).toBe('CANCELLED');
    expect(await ledgerAndStockSnapshot()).toEqual(before); // nothing unwound — nothing was ever written

    // The cancelled GRN drops out of every derived Σ received on the next read.
    const billDto = await query.getBill(billId, actor);
    expect(billDto!.lines[0].receivedQty).toBe('0.0000');
    expect(billDto!.lines[0].matchStatus).toBe('PENDING_RECEIPT');
  });

  it('PM scoping: a PM not assigned to the GRN project gets 403 on read; the supplier register filters to assigned projects (NFR-005)', async () => {
    const { billId, billLines } = await postedBill();
    const { id: grnId } = await createGrn.execute(grnInput(billId, billLines[0].id, '90'), actor);

    const pm: Actor = { ...actor, role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [OTHER_PROJECT] };
    await expect(query.getGrn(grnId, pm)).rejects.toBeInstanceOf(ForbiddenException);
    const reg = await query.supplierRegister(SUPPLIER, pm);
    expect(reg.rows).toHaveLength(0); // the PROJECT bill is invisible to a PM assigned elsewhere
    await expect(query.projectPurchaseRegister(PROJECT, pm)).rejects.toBeInstanceOf(ForbiddenException);

    const listed = await query.listGrns({}, pm);
    expect(listed.items).toHaveLength(0);
  });

  // ── RBAC guard smoke test (skill §13) — the NEW GRN routes + the NEW STORE_KEEPER seed grant ─────────────
  describe('PurchaseGrnsController/PurchaseSuppliersController route RBAC — real RolesGuard against real Postgres Role/Permission', () => {
    const ACCOUNTS_ROLE = '00000000-0000-0000-0000-0000000e8c10';
    const STORE_KEEPER_ROLE = '00000000-0000-0000-0000-0000000e8c11';
    const NO_GRANT_ROLE = '00000000-0000-0000-0000-0000000e8c12';
    const accountsActor: Actor = { ...actor, userId: 'accounts-user', role: 'ACCOUNTS_MANAGER', isUnscoped: true };
    const storeKeeperActor: Actor = {
      ...actor,
      userId: 'store-user',
      role: 'STORE_KEEPER',
      isUnscoped: false,
      assignedProjectIds: [PROJECT],
    };
    const noGrantActor: Actor = { ...actor, userId: 'hr-user', role: 'HR_MANAGER', isUnscoped: false };

    function mockContext(user: Actor | undefined, requirements: PermissionRequirement[]): ExecutionContext {
      jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requirements);
      return {
        getHandler: () => function handler() {},
        getClass: () => class PurchaseGrnsController {},
        switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
      } as unknown as ExecutionContext;
    }

    beforeAll(async () => {
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ACCOUNTS_MANAGER',true,1) ON CONFLICT DO NOTHING`, [ACCOUNTS_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'STORE_KEEPER',false,1) ON CONFLICT DO NOTHING`, [STORE_KEEPER_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'HR_MANAGER',false,1) ON CONFLICT DO NOTHING`, [NO_GRANT_ROLE, CO]);

      for (const action of ['READ', 'CREATE', 'UPDATE', 'DELETE', 'POST', 'CANCEL']) {
        await ds.query(
          `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'purchase.grn', $3, 'ALL', 1)`,
          [ACCOUNTS_ROLE, CO, action],
        );
      }
      // The EXACT grant set seed-roles-permissions.ts now ships for STORE_KEEPER (purchase-grn-matching):
      // PUR:CREATE/READ/POST, ASSIGNED — nothing more (the GRN contract has no PATCH/DELETE/cancel route).
      for (const action of ['CREATE', 'READ', 'POST']) {
        await ds.query(
          `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'purchase.grn', $3, 'ASSIGNED', 1)`,
          [STORE_KEEPER_ROLE, CO, action],
        );
      }
      // HR_MANAGER holds ZERO PUR grant — the 403 case.
    });

    afterEach(() => jest.restoreAllMocks());

    it('401: no/invalid token', () => {
      expect(() => jwtAuthGuard.handleRequest(null, false, null)).toThrow(UnauthorizedException);
      expect(() => jwtAuthGuard.handleRequest(new Error('jwt malformed'), false, null)).toThrow(UnauthorizedException);
    });

    it.each([
      ['POST /grns', 'CREATE'],
      ['GET /grns', 'READ'],
      ['GET /grns/:id', 'READ'],
      ['POST /grns/:id/post', 'POST'],
      ['GET /orders/:id/match', 'READ'],
      ['GET /suppliers/:supplierId/register', 'READ'],
    ] as const)('success: STORE_KEEPER (the new seed grant) may reach %s -> PUR:%s', async (_route, action) => {
      const ctx = mockContext(storeKeeperActor, [{ resource: 'purchase.grn', action }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it.each([
      ['PATCH /bills/:id', 'UPDATE'],
      ['DELETE /bills/:id', 'DELETE'],
      ['POST /bills/:id/cancel', 'CANCEL'],
    ] as const)('403: STORE_KEEPER holds NO PUR:%s (%s) — kept minimal to the GRN routes', async (_route, action) => {
      const ctx = mockContext(storeKeeperActor, [{ resource: 'purchase.grn', action }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['POST /grns', 'CREATE'],
      ['GET /grns', 'READ'],
      ['POST /grns/:id/post', 'POST'],
    ] as const)('403: a role with zero PUR grant is FORBIDDEN on %s -> PUR:%s', async (_route, action) => {
      const ctx = mockContext(noGrantActor, [{ resource: 'purchase.grn', action }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('success: ACCOUNTS_MANAGER may reach every GRN/match/register route', async () => {
      for (const action of ['CREATE', 'READ', 'POST'] as const) {
        const ctx = mockContext(accountsActor, [{ resource: 'purchase.grn', action }]);
        await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
      }
    });

    it('403: RolesGuard rejects when request.user is absent even with @Roles() present (defence-in-depth)', async () => {
      const ctx = mockContext(undefined, [{ resource: 'purchase.grn', action: 'POST' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
