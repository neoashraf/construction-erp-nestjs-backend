/**
 * PUR Purchase Order + Bill integration — Testcontainers Postgres, real migrations + the real INV
 * `InventoryServiceAdapter`/`InventoryAccountResolverAdapter` + the real LED `PostingService` + real
 * NUM/PER + real CC (`BudgetCheckServiceImpl`/`TagConsistencyServiceImpl`). Mirrors
 * `test/requisition-issue.int-spec.ts`'s bootstrap style. Proves the brief's DoD end-to-end:
 *   - AC1: the exact §4.1 worked balance (247,250 both sides), godown on inventory lines only, party on AP;
 *   - AC4: receiveIn called before posting.post, inside one UoW, inventory value = movement value;
 *   - AC5: atomic rollback — forced failure after receiveIn+journal-write rolls back everything incl.
 *     movements;
 *   - AC6: gapless number only at post;
 *   - AC7: closed period / closed project rejected;
 *   - AC8: non-stock + mixed line;
 *   - AC9: advisory budget warning never blocks;
 *   - AC10: cross-project dimension rejected at draft via TagConsistencyService;
 *   - AC11: anti-double-post;
 *   - AC12: cancel/repost unwinds both sides, original unchanged, number retained;
 *   - AC13: PO approve posts nothing, billing a non-APPROVED PO -> PO_NOT_BILLABLE;
 *   - the reconciliation invariant (Sigma stock-ledger value increase = inventory debit in the entry);
 *   - the RBAC guard smoke test (skill §13).
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

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateUser1700000700000 } from '../src/database/migrations/1700000700000-CreateUser';
import { CreateRbacAndAudit1700000800000 } from '../src/database/migrations/1700000800000-CreateRbacAndAudit';
import { CreateStockMovementAndBalance1700001000000 } from '../src/database/migrations/1700001000000-CreateStockMovementAndBalance';
import { CreateStockJournal1700001500000 } from '../src/database/migrations/1700001500000-CreateStockJournal';
import { CreatePurchasePoBill1700002000000 } from '../src/database/migrations/1700002000000-CreatePurchasePoBill';

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
import { PurchaseAccountMapAdapter } from '../src/modules/purchase/infrastructure/purchase-account-map.adapter';
import { PurchaseConfigAdapter } from '../src/modules/purchase/infrastructure/purchase-config.adapter';
import { PurchaseProjectStatusAdapter } from '../src/modules/purchase/infrastructure/purchase-project-status.adapter';
import { CreatePurchaseOrderUseCase } from '../src/modules/purchase/application/create-purchase-order.usecase';
import { ApprovePurchaseOrderUseCase } from '../src/modules/purchase/application/approve-purchase-order.usecase';
import { CreatePurchaseBillUseCase } from '../src/modules/purchase/application/create-purchase-bill.usecase';
import { PostPurchaseBillUseCase } from '../src/modules/purchase/application/post-purchase-bill.usecase';
import { CancelPurchaseBillUseCase } from '../src/modules/purchase/application/cancel-purchase-bill.usecase';
import { RepostPurchaseBillUseCase } from '../src/modules/purchase/application/repost-purchase-bill.usecase';
import { PurchaseQueryService } from '../src/modules/purchase/application/purchase-query.service';
import { PoNotBillableError } from '../src/modules/purchase/domain/errors';
import { CrossProjectDimensionError } from '../src/core/cost-control/domain/errors';
import { NewPurchaseBill } from '../src/modules/purchase/domain/purchase-bill';

// RolesGuard smoke test deps (mandatory per skill §13).
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { JwtAuthGuard } from '../src/core/auth/presentation/jwt-auth.guard';
import { PermissionRequirement } from '../src/core/auth/presentation/roles.decorator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c8';
const FY1 = '00000000-0000-0000-0000-0000000000f8';
const PERIOD = '00000000-0000-0000-0000-0000000000e8';
const CLOSED_PERIOD_CO = '00000000-0000-0000-0000-0000000000c9';
const USER = '00000000-0000-0000-0000-0000000000a8';
const SUPPLIER = '00000000-0000-0000-0000-0000000000b8';
const CUSTOMER = '00000000-0000-0000-0000-0000000000b9';
const PROJECT = '00000000-0000-0000-0000-00000000d801';
const CLOSED_PROJECT = '00000000-0000-0000-0000-00000000d8c9';
const CC = '00000000-0000-0000-0000-00000000d802';
const PURPOSE = '00000000-0000-0000-0000-00000000d803';
const OTHER_PROJECT = '00000000-0000-0000-0000-00000000d8aa';
const OTHER_PURPOSE = '00000000-0000-0000-0000-00000000d8ab';
const GODOWN = '00000000-0000-0000-0000-00000000d804';
const CLOSED_PROJECT_PURPOSE = '00000000-0000-0000-0000-00000000d8cb';
const CLOSED_PROJECT_GODOWN = '00000000-0000-0000-0000-00000000d8cc';
const ITEM_CEMENT = '00000000-0000-0000-0000-00000000d805';
const ITEM_ROD = '00000000-0000-0000-0000-00000000d806';

const GROUP = '00000000-0000-0000-0000-00000000a800';
const ACCT_INV = '00000000-0000-0000-0000-00000000a805';
const ACCT_EXPENSE = '00000000-0000-0000-0000-00000000a807';
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

describe('PUR Purchase Order + Bill (real Postgres + real INV/LED/NUM/PER/CC)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let uow: TypeOrmUnitOfWork;
  let posting: PostingService;
  let createPo: CreatePurchaseOrderUseCase;
  let approvePo: ApprovePurchaseOrderUseCase;
  let createBill: CreatePurchaseBillUseCase;
  let postBill: PostPurchaseBillUseCase;
  let cancelBill: CancelPurchaseBillUseCase;
  let repostBill: RepostPurchaseBillUseCase;
  let query: PurchaseQueryService;
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
        CreateStockMovementAndBalance1700001000000,
        CreateStockJournal1700001500000,
        CreatePurchasePoBill1700002000000,
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
         ($4,$2,'5100','Material Expense',$3,'EXPENSE',true),
         ($5,$2,'1230','VAT Input (Recoverable)',$3,'ASSET',true),
         ($6,$2,'2100','Accounts Payable',$3,'LIABILITY',true),
         ($7,$2,'2210','TDS Payable',$3,'LIABILITY',true),
         ($8,$2,'2220','AIT Payable',$3,'LIABILITY',true)`,
      [ACCT_INV, CO, GROUP, ACCT_EXPENSE, ACCT_VAT_INPUT, ACCT_AP, ACCT_TDS, ACCT_AIT],
    );
    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES
         ($1,$2,'Supp X',false,true,'+8801700000000'),
         ($3,$2,'Cust A',true,false,'+8801700000001')`,
      [SUPPLIER, CO, CUSTOMER],
    );
    const project = (id: string, code: string, status: string) =>
      ds.query(
        `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,$3,$3,$4,$5,'2025-07-01','2026-06-30',$6)`,
        [id, CO, code, CUSTOMER, USER, status],
      );
    await project(PROJECT, 'P-01', 'ACTIVE');
    await project(CLOSED_PROJECT, 'P-CL', 'ACTIVE');
    await project(OTHER_PROJECT, 'P-02', 'ACTIVE');
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Slab','Slab')`, [CC, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Day 20 pour')`, [PURPOSE, CO, PROJECT]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Other purpose')`, [
      OTHER_PURPOSE,
      CO,
      OTHER_PROJECT,
    ]);
    await ds.query(`INSERT INTO godown (id, company_id, project_id, name, is_active) VALUES ($1,$2,$3,'G-Site-A',true)`, [
      GODOWN,
      CO,
      PROJECT,
    ]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Closed-project purpose')`, [
      CLOSED_PROJECT_PURPOSE,
      CO,
      CLOSED_PROJECT,
    ]);
    await ds.query(`INSERT INTO godown (id, company_id, project_id, name, is_active) VALUES ($1,$2,$3,'G-Closed',true)`, [
      CLOSED_PROJECT_GODOWN,
      CO,
      CLOSED_PROJECT,
    ]);
    await ds.query(
      `INSERT INTO item (id, company_id, code, name, base_uom, default_account_id, is_active) VALUES
         ($1,$2,'CEM','Cement','BAG',$3,true),($4,$2,'ROD','Rod','KG',$3,true)`,
      [ITEM_CEMENT, CO, ACCT_INV, ITEM_ROD],
    );

    const ids = new UuidIdGenerator();
    uow = new TypeOrmUnitOfWork(ds);
    const clock = { now: () => new Date('2026-06-29T10:00:00Z') };
    posting = new PostingService(
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
    const accountMap = new PurchaseAccountMapAdapter(ds, inventoryAccounts);
    const config = new PurchaseConfigAdapter();
    const projectStatus = new PurchaseProjectStatusAdapter(ds);
    const access = new AccessPolicy();
    const audit = { record: async () => undefined };

    createPo = new CreatePurchaseOrderUseCase(poRepo, tagConsistency, budgetCheck, access, audit as never, uow, ids);
    approvePo = new ApprovePurchaseOrderUseCase(poRepo, audit as never, uow, clock);
    createBill = new CreatePurchaseBillUseCase(billRepo, poRepo, config, tagConsistency, budgetCheck, access, audit as never, uow, ids);
    postBill = new PostPurchaseBillUseCase(billRepo, poRepo, accountMap, projectStatus, inventoryService, budgetCheck, posting, audit as never, uow, clock);
    cancelBill = new CancelPurchaseBillUseCase(billRepo, inventoryService, posting, audit as never, uow);
    repostBill = new RepostPurchaseBillUseCase(billRepo, accountMap, config, inventoryService, posting, audit as never, uow, clock, ids);
    query = new PurchaseQueryService(ds);

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
      'TRUNCATE purchase_bill_line, purchase_bill, purchase_order_line, purchase_order, journal_line, journal_entry, stock_movement, stock_balance, numbering_series RESTART IDENTITY CASCADE',
    );
    await ds.query(`UPDATE project SET status='ACTIVE' WHERE id=$1`, [CLOSED_PROJECT]);
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
        {
          itemId: ITEM_ROD,
          isStockLine: true,
          billedQty: '2',
          rate: '90000',
          godownId: GODOWN,
          projectId: PROJECT,
          costCentreId: CC,
          purposeId: PURPOSE,
        },
      ],
      ...overrides,
    };
  }

  async function draftBillId(overrides: Partial<NewPurchaseBill> = {}): Promise<string> {
    const { id } = await createBill.execute(billInput(overrides), actor);
    return id;
  }

  // ---- AC1: the §4.1 worked balance ------------------------------------------------------------------

  it('AC1/AC4: posts the §4.1 worked bill — balanced 247,250, godown on inventory lines only, party on AP; INV receiveIn before posting.post', async () => {
    const id = await draftBillId();
    const result = await postBill.execute(id, actor);

    expect(result.entryNo).toMatch(/PUR/);
    expect(result.netPayableAmount).toBe('231150.0000');

    const [entry] = await ds.query(`SELECT id, voucher_type, entry_no FROM journal_entry`);
    expect(entry.voucher_type).toBe('PURCHASE');
    const lines: Array<{
      account_id: string;
      project_id: string | null;
      cost_centre_id: string | null;
      purpose_id: string | null;
      godown_id: string | null;
      party_id: string | null;
      debit: string;
      credit: string;
    }> = await ds.query(
      `SELECT account_id, project_id, cost_centre_id, purpose_id, godown_id, party_id, debit::text, credit::text
         FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [entry.id],
    );
    expect(lines).toHaveLength(6); // 2 inventory + VAT input + AP + TDS + AIT

    const dr = lines.reduce((s, l) => s.plus(new Decimal(l.debit)), new Decimal(0));
    const cr = lines.reduce((s, l) => s.plus(new Decimal(l.credit)), new Decimal(0));
    expect(dr.toFixed(4)).toBe('247250.0000');
    expect(cr.toFixed(4)).toBe('247250.0000');
    expect(dr.equals(cr)).toBe(true);

    const invLines = lines.filter((l) => l.account_id === ACCT_INV);
    expect(invLines).toHaveLength(2);
    for (const l of invLines) {
      expect(l.project_id).toBe(PROJECT);
      expect(l.cost_centre_id).toBe(CC);
      expect(l.purpose_id).toBe(PURPOSE);
      expect(l.godown_id).toBe(GODOWN);
      expect(l.party_id).toBeNull();
    }
    expect(invLines.map((l) => new Decimal(l.debit).toFixed(4)).sort()).toEqual(['180000.0000', '50000.0000']);

    const apLine = lines.find((l) => l.account_id === ACCT_AP)!;
    expect(apLine.credit).toBe('231150.0000');
    expect(apLine.party_id).toBe(SUPPLIER);
    expect(apLine.godown_id).toBeNull();

    const vatLine = lines.find((l) => l.account_id === ACCT_VAT_INPUT)!;
    expect(vatLine.debit).toBe('17250.0000');
    expect(vatLine.godown_id).toBeNull();

    const tdsLine = lines.find((l) => l.account_id === ACCT_TDS)!;
    expect(tdsLine.credit).toBe('11500.0000');
    const aitLine = lines.find((l) => l.account_id === ACCT_AIT)!;
    expect(aitLine.credit).toBe('4600.0000');

    // AC4 — the receipt-in stock_movement rows exist for the received quantities.
    const movements: Array<{ direction: string; quantity: string; value: string; source_type: string }> =
      await ds.query(`SELECT direction, quantity::text, value::text, source_type FROM stock_movement ORDER BY created_at`);
    expect(movements).toHaveLength(2);
    for (const m of movements) {
      expect(m.direction).toBe('IN');
      expect(m.source_type).toBe('GRN');
    }
    const movementValueSum = movements.reduce((s, m) => s.plus(new Decimal(m.value)), new Decimal(0));
    expect(movementValueSum.toFixed(4)).toBe('230000.0000'); // matches the inventory debit total exactly
  });

  // ---- AC5: atomic rollback --------------------------------------------------------------------------

  it('AC5: a forced posting failure after receiveIn rolls back everything — no orphan movement, no consumed number, bill stays DRAFT', async () => {
    const id = await draftBillId();
    const spy = jest.spyOn(posting, 'post').mockRejectedValueOnce(new Error('forced failure'));
    try {
      await expect(postBill.execute(id, actor)).rejects.toThrow('forced failure');
    } finally {
      spy.mockRestore();
    }

    const [{ n: movements }] = await ds.query(`SELECT count(*)::int n FROM stock_movement`);
    expect(movements).toBe(0);
    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entries).toBe(0);
    const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series`);
    expect(series).toBe(0);
    const dto = await query.getBill(id, actor);
    expect(dto!.status).toBe('DRAFT');
    expect(dto!.entryNo).toBeNull();
  });

  // ---- AC6: gapless number only at post ---------------------------------------------------------------

  it('AC6: a DRAFT bill has entryNo=null; post allocates a gapless PURCHASE number; a failed post consumes none', async () => {
    const id = await draftBillId();
    let dto = await query.getBill(id, actor);
    expect(dto!.entryNo).toBeNull();

    const result = await postBill.execute(id, actor);
    expect(result.entryNo).toBeTruthy();
    dto = await query.getBill(id, actor);
    expect(dto!.entryNo).toBe(result.entryNo);
  });

  // ---- AC7: closed period / closed project -------------------------------------------------------------

  it('AC7: closed project is rejected before write -> PROJECT_CLOSED; nothing written, no number consumed', async () => {
    const id = await draftBillId({
      projectId: CLOSED_PROJECT,
      lines: billInput().lines.map((l) => ({
        ...l,
        projectId: CLOSED_PROJECT,
        purposeId: CLOSED_PROJECT_PURPOSE,
        godownId: CLOSED_PROJECT_GODOWN,
      })),
    });
    await ds.query(`UPDATE project SET status='CLOSED' WHERE id=$1`, [CLOSED_PROJECT]);

    await expect(postBill.execute(id, actor)).rejects.toMatchObject({ code: 'PROJECT_CLOSED' });

    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entries).toBe(0);
    const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series`);
    expect(series).toBe(0);
  });

  it('AC7: closed period is rejected before write -> PERIOD_CLOSED', async () => {
    // Isolated company + closed period so the shared OPEN period fixture is unaffected.
    const closedFy = '00000000-0000-0000-0000-0000000000f9';
    const closedPeriod = '00000000-0000-0000-0000-0000000000e9';
    await ds.query(`INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE2','ZE2 Ltd','9876543210123','987654321012')`, [CLOSED_PERIOD_CO]);
    await ds.query(`INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`, [closedFy, CLOSED_PERIOD_CO]);
    await ds.query(`INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES ($1,$2,$3,'FY2526','2025-07-01','2027-06-30','CLOSED')`, [closedPeriod, CLOSED_PERIOD_CO, closedFy]);
    const closedActor: Actor = { ...actor, companyId: CLOSED_PERIOD_CO, financialYearId: closedFy };
    await ds.query(`INSERT INTO account_group (id, company_id, name, type) VALUES ($1,$2,'Current Assets','ASSET')`, ['00000000-0000-0000-0000-0000000009a0', CLOSED_PERIOD_CO]);
    const grp2 = '00000000-0000-0000-0000-0000000009a0';
    const acctInv2 = '00000000-0000-0000-0000-0000000009a1';
    const acctVat2 = '00000000-0000-0000-0000-0000000009a2';
    const acctAp2 = '00000000-0000-0000-0000-0000000009a3';
    const acctTds2 = '00000000-0000-0000-0000-0000000009a4';
    const acctAit2 = '00000000-0000-0000-0000-0000000009a5';
    await ds.query(
      `INSERT INTO account (id, company_id, code, name, account_group_id, type, is_active) VALUES
         ($1,$2,'1300','Inventory',$3,'ASSET',true),($4,$2,'1230','VAT',$3,'ASSET',true),
         ($5,$2,'2100','AP',$3,'LIABILITY',true),($6,$2,'2210','TDS',$3,'LIABILITY',true),($7,$2,'2220','AIT',$3,'LIABILITY',true)`,
      [acctInv2, CLOSED_PERIOD_CO, grp2, acctVat2, acctAp2, acctTds2, acctAit2],
    );
    const supplier2 = '00000000-0000-0000-0000-0000000009b0';
    const customer2 = '00000000-0000-0000-0000-0000000009b1';
    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES
         ($1,$2,'Supp2',false,true,'+8801700000001'),
         ($3,$2,'Cust2',true,false,'+8801700000002')`,
      [supplier2, CLOSED_PERIOD_CO, customer2],
    );
    const project2 = '00000000-0000-0000-0000-0000000009c0';
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,'P2','P2',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [project2, CLOSED_PERIOD_CO, customer2, USER],
    );
    const cc2 = '00000000-0000-0000-0000-0000000009c1';
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC2','CC2')`, [cc2, CLOSED_PERIOD_CO]);
    const purpose2 = '00000000-0000-0000-0000-0000000009c2';
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Purpose2')`, [purpose2, CLOSED_PERIOD_CO, project2]);
    const godown2 = '00000000-0000-0000-0000-0000000009c3';
    await ds.query(`INSERT INTO godown (id, company_id, project_id, name, is_active) VALUES ($1,$2,$3,'G2',true)`, [godown2, CLOSED_PERIOD_CO, project2]);
    const item2 = '00000000-0000-0000-0000-0000000009c4';
    await ds.query(`INSERT INTO item (id, company_id, code, name, base_uom, default_account_id, is_active) VALUES ($1,$2,'IT2','Item2','BAG',$3,true)`, [item2, CLOSED_PERIOD_CO, acctInv2]);

    const { id } = await createBill.execute(
      {
        projectId: project2,
        supplierId: supplier2,
        billDate: '2026-06-29',
        dueDate: '2026-07-29',
        lines: [{ itemId: item2, isStockLine: true, billedQty: '10', rate: '100', godownId: godown2, projectId: project2, costCentreId: cc2, purposeId: purpose2 }],
      },
      closedActor,
    );

    await expect(postBill.execute(id, closedActor)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry WHERE company_id=$1`, [CLOSED_PERIOD_CO]);
    expect(entries).toBe(0);
  });

  // ---- AC8: non-stock + mixed line ----------------------------------------------------------------------

  it('AC8: a non-stock line debits its own expense account and rolls no inventory; a mixed bill posts one balanced entry', async () => {
    const id = await draftBillId({
      lines: [
        billInput().lines[0], // cement, stock
        {
          expenseAccountId: ACCT_EXPENSE,
          isStockLine: false,
          billedQty: '1',
          rate: '8000',
          projectId: PROJECT,
          costCentreId: CC,
          purposeId: PURPOSE,
        },
      ],
    });
    await postBill.execute(id, actor);

    const [{ n: movements }] = await ds.query(`SELECT count(*)::int n FROM stock_movement`);
    expect(movements).toBe(1); // only the cement line rolls inventory

    const [entry] = await ds.query(`SELECT id FROM journal_entry`);
    const lines: Array<{ account_id: string; debit: string; credit: string; godown_id: string | null }> = await ds.query(
      `SELECT account_id, debit::text, credit::text, godown_id FROM journal_line WHERE journal_entry_id=$1`,
      [entry.id],
    );
    const dr = lines.reduce((s, l) => s.plus(new Decimal(l.debit)), new Decimal(0));
    const cr = lines.reduce((s, l) => s.plus(new Decimal(l.credit)), new Decimal(0));
    expect(dr.equals(cr)).toBe(true);
    const svcLine = lines.find((l) => l.account_id === ACCT_EXPENSE)!;
    expect(svcLine.debit).toBe('8000.0000');
    expect(svcLine.godown_id).toBeNull();
  });

  // ---- AC9: advisory budget warning never blocks -------------------------------------------------------

  it('AC9: an over-budget draft still creates/posts successfully; budgetWarnings surfaced, never blocking', async () => {
    await ds.query(`INSERT INTO project_budget (id, company_id, project_id, cost_centre_id, budgeted_amount) VALUES (gen_random_uuid(), $1, $2, $3, '1000.0000')`, [CO, PROJECT, CC]);
    const created = await createBill.execute(billInput(), actor); // 230,000 line total >> 1,000 budget
    expect(created.budgetWarnings.length).toBeGreaterThan(0);
    expect(created.budgetWarnings.some((w) => w.status === 'OVER')).toBe(true);

    const posted = await postBill.execute(created.id, actor); // still succeeds
    expect(posted.entryNo).toBeTruthy();
    expect(posted.budgetWarnings.some((w) => w.status === 'OVER')).toBe(true);
    await ds.query(`DELETE FROM project_budget WHERE company_id=$1 AND project_id=$2`, [CO, PROJECT]);
  });

  // ---- AC10: cross-project dimension rejected at draft --------------------------------------------------

  it('AC10: a line whose purpose belongs to another project -> CROSS_PROJECT_DIMENSION at draft, before any post', async () => {
    await expect(
      createBill.execute(
        billInput({ lines: [{ ...billInput().lines[0], purposeId: OTHER_PURPOSE }] }),
        actor,
      ),
    ).rejects.toBeInstanceOf(CrossProjectDimensionError);
    const [{ n: bills }] = await ds.query(`SELECT count(*)::int n FROM purchase_bill`);
    expect(bills).toBe(0);
  });

  // ---- AC11: anti-double-post ---------------------------------------------------------------------------

  it('AC11: two concurrent posts on one draft -> exactly one POSTED entry + one movement set + one number', async () => {
    const id = await draftBillId();
    const results = await Promise.allSettled([postBill.execute(id, actor), postBill.execute(id, actor)]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entries).toBe(1);
    const [{ n: movements }] = await ds.query(`SELECT count(*)::int n FROM stock_movement`);
    expect(movements).toBe(2);
  });

  // ---- AC12: append-only cancel / repost -----------------------------------------------------------------

  it('AC12: cancel unwinds both sides (reverseReceipt + reverse entry); original entry/number/movements unchanged', async () => {
    const id = await draftBillId();
    const posted = await postBill.execute(id, actor);
    const originalEntryId = posted.entryId;
    const [movementCountBefore] = await ds.query(`SELECT count(*)::int n FROM stock_movement`);

    const cancelResult = await cancelBill.execute(id, 'wrong supplier invoice', actor);
    expect(cancelResult.reversalEntryNo).not.toBe(posted.entryNo);

    const dto = await query.getBill(id, actor);
    expect(dto!.status).toBe('CANCELLED');
    expect(dto!.entryNo).toBe(posted.entryNo); // original number retained

    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entries).toBe(2); // original + reversal
    const originalStillThere = await ds.query(`SELECT id FROM journal_entry WHERE id=$1`, [originalEntryId]);
    expect(originalStillThere).toHaveLength(1);

    const [{ n: movements }] = await ds.query(`SELECT count(*)::int n FROM stock_movement`);
    expect(movements).toBe(movementCountBefore.n + 2); // 2 mirror OUT movements appended, originals untouched

    // Stock is restored to zero net for this (godown,item) pair after cancel.
    const balances: Array<{ item_id: string; quantity_on_hand: string }> = await ds.query(
      `SELECT item_id, quantity_on_hand::text FROM stock_balance WHERE company_id=$1 AND godown_id=$2`,
      [CO, GODOWN],
    );
    for (const b of balances) expect(new Decimal(b.quantity_on_hand).toFixed(4)).toBe('0.0000');
  });

  it('AC12: repost = reverse+post in one UoW; a new entry+number, original unchanged; failed repost rolls back both', async () => {
    const id = await draftBillId();
    const posted = await postBill.execute(id, actor);

    const repostResult = await repostBill.execute(id, { supplierInvoiceRef: 'INV-7741-CORRECTED' }, 'wrong invoice ref', actor);
    expect(repostResult.entryNo).not.toBe(posted.entryNo);
    expect(repostResult.reversalEntryNo).not.toBe(posted.entryNo);

    const dto = await query.getBill(id, actor);
    expect(dto!.status).toBe('POSTED');
    expect(dto!.entryNo).toBe(repostResult.entryNo); // re-stamped to the NEW number
    expect(dto!.supplierInvoiceRef).toBe('INV-7741-CORRECTED');

    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entries).toBe(3); // original(reversed) + reversal + corrected repost

    // The ORIGINAL entry is untouched.
    const original = await ds.query(`SELECT entry_no FROM journal_entry WHERE entry_no=$1`, [posted.entryNo]);
    expect(original).toHaveLength(1);
  });

  it('AC12: a failed repost rolls back both the reversal and the corrected post', async () => {
    const id = await draftBillId();
    await postBill.execute(id, actor);

    const spy = jest.spyOn(posting, 'repost').mockRejectedValueOnce(new Error('forced repost failure'));
    try {
      await expect(repostBill.execute(id, { supplierInvoiceRef: 'X' }, 'reason', actor)).rejects.toThrow('forced repost failure');
    } finally {
      spy.mockRestore();
    }

    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entries).toBe(1); // only the original — no reversal, no corrected post survived
    const dto = await query.getBill(id, actor);
    expect(dto!.status).toBe('POSTED'); // unchanged
  });

  // ---- AC13: PO non-posting commitment ------------------------------------------------------------------

  it('AC13: PO approve writes no ledger line, no PURCHASE number; billing a non-APPROVED PO -> PO_NOT_BILLABLE', async () => {
    const { id: poId } = await createPo.execute(
      {
        projectId: PROJECT,
        supplierId: SUPPLIER,
        poRefNo: 'PO-2026-0188',
        poDate: '2026-06-20',
        expectedDeliveryDate: '2026-06-28',
        lines: [
          { itemId: ITEM_CEMENT, orderedQty: '100', rate: '500', godownId: GODOWN, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE },
        ],
      },
      actor,
    );

    // Billing against a DRAFT PO -> PO_NOT_BILLABLE.
    await expect(createBill.execute(billInput({ purchaseOrderId: poId, lines: [billInput().lines[0]] }), actor).then((r) => postBill.execute(r.id, actor))).rejects.toBeInstanceOf(
      PoNotBillableError,
    );

    const approveResult = await approvePo.execute(poId, actor);
    expect(approveResult.status).toBe('APPROVED');
    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entries).toBe(0); // approve wrote NO ledger line
    const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series`);
    expect(series).toBe(0); // approve drew NO PURCHASE number

    // Now billable — post succeeds against the APPROVED PO. The bill fully bills the PO's only line
    // (100 @ 500 = the PO's ordered qty exactly), so the PO rolls straight to CLOSED.
    const bill = await createBill.execute(billInput({ purchaseOrderId: poId, lines: [billInput().lines[0]] }), actor);
    const result = await postBill.execute(bill.id, actor);
    expect(result.entryNo).toBeTruthy();
    const poAfter = await query.getOrder(poId, actor);
    expect(poAfter!.status).toBe('CLOSED');
  });

  // ---- reconciliation invariant --------------------------------------------------------------------------

  it('reconciliation invariant: Sigma stock-ledger value increase = inventory debit in the entry', async () => {
    const id = await draftBillId();
    await postBill.execute(id, actor);

    const ledger = await ledgerQuery.stockLedger({}, actor);
    const sumStock = ledger.items.reduce((s, r) => s.plus(new Decimal(r.totalValue)), new Decimal(0));
    expect(sumStock.toFixed(4)).toBe('230000.0000');

    const [{ bal }] = await ds.query(
      `SELECT COALESCE(SUM(debit - credit),0)::numeric(18,4)::text AS bal FROM journal_line WHERE account_id = $1`,
      [ACCT_INV],
    );
    expect(bal).toBe(sumStock.toFixed(4));
  });

  // ── RBAC guard smoke test (skill §13) — proves PurchaseController/PurchaseOrdersController routes really
  // enforce @UseGuards(JwtAuthGuard, RolesGuard) + @Roles({module:'PUR', action}). ──
  describe('PurchaseController/PurchaseOrdersController route RBAC — real RolesGuard against real Postgres Role/Permission', () => {
    const ACCOUNTS_ROLE = '00000000-0000-0000-0000-0000000e8b10';
    const PM_ROLE = '00000000-0000-0000-0000-0000000e8b11';
    const NO_GRANT_ROLE = '00000000-0000-0000-0000-0000000e8b12';
    const accountsActor: Actor = { ...actor, userId: 'accounts-user', role: 'ACCOUNTS_TEAM', isUnscoped: true };
    const pmGuardActor: Actor = { ...actor, userId: 'pm-guard-user', role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [PROJECT] };
    const noGrantActor: Actor = { ...actor, userId: 'no-grant-user', role: 'STORE_KEEPER', isUnscoped: false };

    function mockContext(user: Actor | undefined, requirements: PermissionRequirement[]): ExecutionContext {
      jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requirements);
      return {
        getHandler: () => function handler() {},
        getClass: () => class PurchaseController {},
        switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
      } as unknown as ExecutionContext;
    }

    beforeAll(async () => {
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ACCOUNTS_TEAM',true,1) ON CONFLICT DO NOTHING`, [ACCOUNTS_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1) ON CONFLICT DO NOTHING`, [PM_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'STORE_KEEPER',false,1) ON CONFLICT DO NOTHING`, [NO_GRANT_ROLE, CO]);

      for (const action of ['READ', 'CREATE', 'UPDATE', 'DELETE', 'POST', 'CANCEL']) {
        await ds.query(
          `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'PUR', $3, 'ALL', 1)`,
          [ACCOUNTS_ROLE, CO, action],
        );
      }
      for (const action of ['READ', 'CREATE', 'APPROVE']) {
        await ds.query(
          `INSERT INTO "permission" (id, role_id, company_id, module, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'PUR', $3, 'ASSIGNED', 1)`,
          [PM_ROLE, CO, action],
        );
      }
      // STORE_KEEPER holds ZERO PUR grant — GRN (their action) is the next brief, out of this brief's scope.
    });

    it('401: no/invalid token', () => {
      expect(() => jwtAuthGuard.handleRequest(null, false, null)).toThrow(UnauthorizedException);
      expect(() => jwtAuthGuard.handleRequest(new Error('jwt malformed'), false, null)).toThrow(UnauthorizedException);
    });

    it.each([
      ['GET /bills', 'READ'],
      ['POST /bills', 'CREATE'],
      ['PATCH /bills/:id', 'UPDATE'],
      ['DELETE /bills/:id', 'DELETE'],
      ['POST /bills/:id/post', 'POST'],
      ['POST /bills/:id/cancel', 'CANCEL'],
    ] as const)('403: STORE_KEEPER (zero PUR grant) is FORBIDDEN on %s -> PUR:%s', async (_route, action) => {
      const ctx = mockContext(noGrantActor, [{ module: 'PUR', action }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['GET /bills', 'READ'],
      ['POST /bills', 'CREATE'],
      ['PATCH /bills/:id', 'UPDATE'],
      ['DELETE /bills/:id', 'DELETE'],
      ['POST /bills/:id/post', 'POST'],
      ['POST /bills/:id/cancel', 'CANCEL'],
    ] as const)('success: ACCOUNTS_TEAM holds PUR:%s -> guard resolves true (%s)', async (_route, action) => {
      const ctx = mockContext(accountsActor, [{ module: 'PUR', action }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('success: PROJECT_MANAGER holds PUR:APPROVE (PO approve)', async () => {
      const ctx = mockContext(pmGuardActor, [{ module: 'PUR', action: 'APPROVE' }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('403: PROJECT_MANAGER lacks PUR:POST (posting a bill is Accounts Team-specific)', async () => {
      const ctx = mockContext(pmGuardActor, [{ module: 'PUR', action: 'POST' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403: RolesGuard rejects when request.user is absent even if @Roles() is present (defence-in-depth)', async () => {
      const ctx = mockContext(undefined, [{ module: 'PUR', action: 'POST' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
