/**
 * INV InventoryService (PUR/REQ seam) integration — Testcontainers Postgres, real migrations + triggers +
 * the real PostingService/NUM/PER (skill §13, brief 3 of 3). Mirrors `test/inventory-stock-journal.int-
 * spec.ts`'s bootstrap style exactly (same fixtures/migrations, directly-`new`'d repos/services). PUR/REQ
 * are not built yet (their own briefs), so these tests play the role of "the caller" the design intends —
 * exactly what a real PUR goods-receipt / REQ issue-posting use case will do: open a UnitOfWork, call
 * `receiveIn`/`issueOut`, and (for `issueOut`) build + post its own consumption `PostingCommand`.
 *
 * Proves the brief's AC list:
 *   - receiveIn rolls the average via the SAME applyReceipt the Stock Journal uses, writes a traceable
 *     IN/GRN movement, creates no StockJournal voucher (FR-INV-006/-002);
 *   - issueOut values at the current source average, writes an OUT/REQ_ISSUE movement, blocks/authorises
 *     negative stock (FR-INV-003/-014/-015);
 *   - a caller-built consumption command (Dr material expense / Cr inventory) posts balanced + tagged via
 *     the REAL PostingService, exactly once, inside the SAME UoW as issueOut (FR-INV-016);
 *   - the whole thing is atomic with the caller's transaction — a forced posting failure rolls the
 *     movement back too, no number consumed (FR-INV-018);
 *   - the SAME locked re-roll (currentBalanceForUpdate) a Stock Journal post uses serialises concurrent
 *     issueOut calls on one (godown,item) — no lost update (FR-INV-010, design §5.4);
 *   - no new HTTP endpoint — InventoryModule's controllers are unchanged by this brief;
 *   - the reconciliation invariant holds ACROSS paths: a receipt-in (port) + an issue-out (port, with its
 *     consumption posted) + a Stock-Journal transfer (brief 2, real use cases) leave Σ stock-ledger
 *     totalValue equal to the inventory account balance in journal_line (FR-INV-005).
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
import { ItemOrmEntity } from '../src/modules/master-data/item/infrastructure/item.orm-entity';
import { StockMovementOrmEntity } from '../src/modules/inventory/infrastructure/stock-movement.orm-entity';
import { StockBalanceOrmEntity } from '../src/modules/inventory/infrastructure/stock-balance.orm-entity';
import {
  StockJournalLineOrmEntity,
  StockJournalOrmEntity,
} from '../src/modules/inventory/infrastructure/stock-journal.orm-entity';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateStockMovementAndBalance1700001000000 } from '../src/database/migrations/1700001000000-CreateStockMovementAndBalance';
import { CreateStockJournal1700001500000 } from '../src/database/migrations/1700001500000-CreateStockJournal';

import { TypeOrmJournalEntryRepository } from '../src/core/posting/infrastructure/typeorm-journal-entry.repository';
import { TypeOrmNumberingService } from '../src/core/numbering/infrastructure/typeorm-numbering.service';
import { TypeOrmAccountingPeriodRepository } from '../src/core/period/infrastructure/typeorm-accounting-period.repository';
import { PeriodServiceImpl } from '../src/core/period/application/period.service';
import { OverviewTagMatrix } from '../src/core/posting/domain/tag-matrix';
import {
  AllowAllMasterLookupService,
  AllowAllProjectStatusService,
} from '../src/core/posting/infrastructure/mas-seam.adapters';
import { PostingCommand } from '../src/core/posting/domain/posting-command';
import { PostingService } from '../src/core/posting/application/posting.service';
import { Money } from '../src/common/money';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { getManager } from '../src/infrastructure/unit-of-work/transaction-context';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { Actor } from '../src/core/tenancy/tenant-context';
import { AccessPolicy } from '../src/core/auth/domain/access-policy';

import { TypeOrmStockMovementRepository } from '../src/modules/inventory/infrastructure/typeorm-stock-movement.repository';
import { TypeOrmStockJournalRepository } from '../src/modules/inventory/infrastructure/typeorm-stock-journal.repository';
import { InventoryAccountResolverAdapter } from '../src/modules/inventory/infrastructure/inventory-account-resolver.adapter';
import { StockLedgerQueryService } from '../src/modules/inventory/application/stock-ledger-query.service';
import { InventoryServiceAdapter } from '../src/modules/inventory/application/inventory.service';
import { CreateStockJournalUseCase } from '../src/modules/inventory/application/create-stock-journal.usecase';
import { ApproveStockJournalUseCase } from '../src/modules/inventory/application/approve-stock-journal.usecase';
import { PostStockJournalUseCase } from '../src/modules/inventory/application/post-stock-journal.usecase';
import { NegativeStockError } from '../src/modules/inventory/domain/errors';
import { InventoryModule } from '../src/modules/inventory/inventory.module';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const PERIOD = '00000000-0000-0000-0000-0000000000e1';
const USER = '00000000-0000-0000-0000-0000000000a1';
const CUSTOMER = '00000000-0000-0000-0000-0000000000b1';
const PROJECT = '00000000-0000-0000-0000-00000000d001';
const CC = '00000000-0000-0000-0000-00000000d002';
const PURPOSE = '00000000-0000-0000-0000-00000000d003';
const GODOWN_A = '00000000-0000-0000-0000-00000000d0a0';
const GODOWN_B = '00000000-0000-0000-0000-00000000d0b0';
const ITEM = '00000000-0000-0000-0000-00000000d012';

const GROUP = '00000000-0000-0000-0000-00000000a000';
const ACCT_INV = '00000000-0000-0000-0000-00000000a005';
const ACCT_EXPENSE = '00000000-0000-0000-0000-00000000a007';
const ACCT_AP = '00000000-0000-0000-0000-00000000a008'; // the receipt's contra side — PUR's own AP posting (out of this brief's scope), seeded here only to prove the cross-path reconciliation invariant

// stock_movement.source_id is a `uuid` column — every GRN/REQ_ISSUE source id below must be a real UUID.
const GRN_1 = '00000000-0000-0000-0000-0000000e0001';
const GRN_2 = '00000000-0000-0000-0000-0000000e0002';
const GRN_3 = '00000000-0000-0000-0000-0000000e0003';
const GRN_4 = '00000000-0000-0000-0000-0000000e0004';
const GRN_5 = '00000000-0000-0000-0000-0000000e0005';
const GRN_6 = '00000000-0000-0000-0000-0000000e0006';
const REQ_ISSUE_1 = '00000000-0000-0000-0000-0000000f0001';
const REQ_ISSUE_2 = '00000000-0000-0000-0000-0000000f0002';
const REQ_ISSUE_3 = '00000000-0000-0000-0000-0000000f0003';
const REQ_ISSUE_4 = '00000000-0000-0000-0000-0000000f0004';
const REQ_ISSUE_5 = '00000000-0000-0000-0000-0000000f0005';
const REQ_ISSUE_6 = '00000000-0000-0000-0000-0000000f0006';

const actor: Actor = {
  userId: USER,
  companyId: CO,
  financialYearId: FY1,
  role: 'StoreKeeper',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

describe('INV InventoryService — the PUR/REQ seam (real Postgres + real PostingService)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let uow: TypeOrmUnitOfWork;
  let posting: PostingService;
  let inventoryService: InventoryServiceAdapter;
  let accounts: InventoryAccountResolverAdapter;
  let ledgerQuery: StockLedgerQueryService;
  let ids: UuidIdGenerator;
  let createUc: CreateStockJournalUseCase;
  let approveUc: ApproveStockJournalUseCase;
  let postUc: PostStockJournalUseCase;

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
        ItemOrmEntity,
        StockMovementOrmEntity,
        StockBalanceOrmEntity,
        StockJournalOrmEntity,
        StockJournalLineOrmEntity,
      ],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateLedger1700000400000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
        CreateStockMovementAndBalance1700001000000,
        CreateStockJournal1700001500000,
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
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status)
         VALUES ($1,$2,'P-01','Tower A',$3,$4,'2025-07-01','2027-06-30','ACTIVE')`,
      [PROJECT, CO, CUSTOMER, USER],
    );
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Slab','Slab')`, [CC, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Day 20 pour')`, [
      PURPOSE,
      CO,
      PROJECT,
    ]);
    await ds.query(`INSERT INTO godown (id, company_id, project_id, name) VALUES ($1,$2,$3,'Site A'),($4,$2,$3,'Site B')`, [
      GODOWN_A,
      CO,
      PROJECT,
      GODOWN_B,
    ]);

    await ds.query(`INSERT INTO account_group (id, company_id, name, type) VALUES ($1,$2,'Current Assets','ASSET')`, [
      GROUP,
      CO,
    ]);
    await ds.query(
      `INSERT INTO account (id, company_id, code, name, account_group_id, type, is_active) VALUES
         ($1,$2,'1300','Inventory',$3,'ASSET',true),
         ($4,$2,'5100','Material Expense',$3,'EXPENSE',true),
         ($5,$2,'2100','Accounts Payable',$3,'LIABILITY',true)`,
      [ACCT_INV, CO, GROUP, ACCT_EXPENSE, ACCT_AP],
    );
    await ds.query(
      `INSERT INTO item (id, company_id, code, name, base_uom, default_account_id, is_active) VALUES ($1,$2,'CEM','Cement','BAG',$3,true)`,
      [ITEM, CO, ACCT_INV],
    );

    ids = new UuidIdGenerator();
    uow = new TypeOrmUnitOfWork(ds);
    const clock = { now: () => new Date('2026-07-15T10:00:00Z') };
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
    inventoryService = new InventoryServiceAdapter(movementRepo, ids, clock);
    accounts = new InventoryAccountResolverAdapter(ds);
    ledgerQuery = new StockLedgerQueryService(ds);

    // brief-2 apparatus, reused for the cross-path reconciliation test only.
    const journalRepo = new TypeOrmStockJournalRepository(ds, ids);
    const access = new AccessPolicy();
    const audit = { record: async () => undefined };
    const noopTagConsistency = { assertConsistent: async () => undefined };
    createUc = new CreateStockJournalUseCase(journalRepo, noopTagConsistency as never, audit as never, uow, ids);
    approveUc = new ApproveStockJournalUseCase(journalRepo, access, audit as never, uow, clock);
    postUc = new PostStockJournalUseCase(journalRepo, movementRepo, posting, accounts, audit as never, uow, clock, ids);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await ds.query(
      'TRUNCATE stock_journal_line, stock_journal, stock_movement, stock_balance, journal_line, journal_entry, numbering_series RESTART IDENTITY CASCADE',
    );
  });

  /**
   * Seeds a balanced Dr Inventory / Cr Accounts Payable entry via raw SQL — representing the receipt's
   * OWN AP-side posting that PUR's goods-receipt voucher will make in its own brief (out of THIS brief's
   * scope: `receiveIn` only rolls the average + writes the movement, per FR-INV-006). Wrapped in one
   * `uow.run` so the deferred balance trigger sees both lines together at commit (mirrors
   * `inventory-stock-ledger.int-spec.ts`'s `insertBalancedEntry` helper).
   */
  async function seedReceiptGl(value: string) {
    await uow.run(async () => {
      const m = getManager(ds);
      const eid = ids.next();
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, posted_at, posted_by)
           VALUES ($1,$2,$3,$4,'PURCHASE','2026-07-15','GRN',$5, now(), $6)`,
        [eid, CO, FY1, `GRN/${eid.slice(0, 8)}`, ids.next(), USER],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, godown_id, debit, credit)
           VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,0)`,
        [ids.next(), eid, ACCT_INV, PROJECT, CC, PURPOSE, GODOWN_A, value],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, godown_id, debit, credit)
           VALUES ($1,$2,2,$3,$4,$5,$6,$7,0,$8)`,
        [ids.next(), eid, ACCT_AP, PROJECT, CC, PURPOSE, GODOWN_A, value],
      );
    });
  }

  /** Builds the same Dr material expense / Cr inventory command a REQ issue-posting use case will build. */
  async function buildConsumptionCommand(sourceId: string, value: Decimal, rate: Decimal): Promise<PostingCommand> {
    const inventoryAccountId = await accounts.inventoryAccountOf(CO, ITEM);
    const expenseAccountId = await accounts.expenseAccountOf(CO);
    void rate;
    return {
      companyId: CO,
      financialYearId: FY1,
      voucherType: 'STOCK_JOURNAL',
      voucherDate: '2026-07-15',
      sourceType: 'REQ_ISSUE',
      sourceId,
      postedBy: USER,
      lines: [
        {
          accountId: expenseAccountId,
          projectId: PROJECT,
          costCentreId: CC,
          purposeId: PURPOSE,
          godownId: GODOWN_A,
          debit: Money.of(value),
          credit: Money.zero(),
          accountType: 'EXPENSE',
          isControlAccount: false,
        },
        {
          accountId: inventoryAccountId,
          projectId: PROJECT,
          costCentreId: CC,
          purposeId: PURPOSE,
          godownId: GODOWN_A,
          debit: Money.zero(),
          credit: Money.of(value),
          accountType: 'ASSET',
          isControlAccount: false,
        },
      ],
    };
  }

  it('AC: receiveIn rolls the average via applyReceipt, writes a traceable IN/GRN movement, no voucher created (FR-INV-006/-002)', async () => {
    const res = await uow.run(() =>
      inventoryService.receiveIn(
        { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
        { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('100'), rate: new Decimal('520'), sourceId: GRN_1 },
      ),
    );
    expect(res.avgRate?.toFixed(4)).toBe('520.0000');
    const [row] = await ds.query(
      `SELECT direction, source_type, source_id, balance_qty_after::text AS q FROM stock_movement WHERE source_id=$1`,
      [GRN_1],
    );
    expect(row.direction).toBe('IN');
    expect(row.source_type).toBe('GRN');
    expect(row.q).toBe('100.0000');
    const [{ n }] = await ds.query(`SELECT count(*)::int n FROM stock_journal`);
    expect(n).toBe(0);
  });

  it('AC: issueOut values at the current source average, writes OUT/REQ_ISSUE, blocks/authorises negative stock (FR-INV-003/-014/-015)', async () => {
    await uow.run(() =>
      inventoryService.receiveIn(
        { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
        { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('10'), rate: new Decimal('520'), sourceId: GRN_2 },
      ),
    );
    await expect(
      uow.run(() =>
        inventoryService.issueOut(
          { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
          { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('50'), allowNegative: false, sourceId: REQ_ISSUE_1 },
        ),
      ),
    ).rejects.toThrow(NegativeStockError);

    const res = await uow.run(() =>
      inventoryService.issueOut(
        { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
        { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('50'), allowNegative: true, sourceId: REQ_ISSUE_1 },
      ),
    );
    expect(res.issuedValue.toFixed(4)).toBe('26000.0000');
    const [row] = await ds.query(
      `SELECT direction, source_type FROM stock_movement WHERE source_id=$1`,
      [REQ_ISSUE_1],
    );
    expect(row.direction).toBe('OUT');
    expect(row.source_type).toBe('REQ_ISSUE');
  });

  it('AC: a caller-built consumption command posts Dr expense/Cr inventory balanced+tagged, exactly once, inside the SAME UoW as issueOut (FR-INV-016)', async () => {
    await uow.run(() =>
      inventoryService.receiveIn(
        { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
        { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('100'), rate: new Decimal('520'), sourceId: GRN_3 },
      ),
    );

    const postSpy = jest.spyOn(posting, 'post');
    await uow.run(async () => {
      const { issuedValue, rate } = await inventoryService.issueOut(
        { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
        { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('40'), allowNegative: false, sourceId: REQ_ISSUE_2 },
      );
      const cmd = await buildConsumptionCommand(REQ_ISSUE_2, issuedValue, rate);
      await posting.post(cmd);
    });
    expect(postSpy).toHaveBeenCalledTimes(1);
    postSpy.mockRestore();

    const [entry] = await ds.query(`SELECT id, voucher_type FROM journal_entry`);
    expect(entry.voucher_type).toBe('STOCK_JOURNAL');
    const lines = await ds.query(
      `SELECT account_id, project_id, cost_centre_id, purpose_id, godown_id, debit::text AS debit, credit::text AS credit
         FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [entry.id],
    );
    expect(lines).toHaveLength(2);
    const dr = lines.reduce((s: Decimal, l: { debit: string }) => s.plus(new Decimal(l.debit)), new Decimal(0));
    const cr = lines.reduce((s: Decimal, l: { credit: string }) => s.plus(new Decimal(l.credit)), new Decimal(0));
    expect(dr.toFixed(4)).toBe(cr.toFixed(4));
    expect(dr.toFixed(4)).toBe('20800.0000'); // 40 * 520
    for (const l of lines) {
      expect(l.project_id).toBe(PROJECT);
      expect(l.cost_centre_id).toBe(CC);
      expect(l.purpose_id).toBe(PURPOSE);
      expect(l.godown_id).toBe(GODOWN_A);
    }
  });

  it('AC: atomic with the caller — a forced posting failure rolls the movement back too, no number consumed (FR-INV-018)', async () => {
    await uow.run(() =>
      inventoryService.receiveIn(
        { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
        { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('100'), rate: new Decimal('520'), sourceId: GRN_4 },
      ),
    );
    const spy = jest.spyOn(posting, 'post').mockRejectedValueOnce(new Error('forced failure'));
    try {
      await expect(
        uow.run(async () => {
          const { issuedValue, rate } = await inventoryService.issueOut(
            { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
            { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('10'), allowNegative: false, sourceId: REQ_ISSUE_3 },
          );
          const cmd = await buildConsumptionCommand(REQ_ISSUE_3, issuedValue, rate);
          await posting.post(cmd);
        }),
      ).rejects.toThrow('forced failure');
    } finally {
      spy.mockRestore();
    }
    const [{ n: moves }] = await ds.query(`SELECT count(*)::int n FROM stock_movement WHERE source_id=$1`, [
      REQ_ISSUE_3,
    ]);
    expect(moves).toBe(0);
    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entries).toBe(0);
    const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series`);
    expect(series).toBe(0);
  });

  it('AC: shares the locked re-roll — concurrent issueOut calls on one (godown,item) serialise, no lost update (FR-INV-010, design §5.4)', async () => {
    await uow.run(() =>
      inventoryService.receiveIn(
        { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
        { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('100'), rate: new Decimal('520'), sourceId: GRN_5 },
      ),
    );
    await Promise.all([
      uow.run(() =>
        inventoryService.issueOut(
          { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
          { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('20'), allowNegative: false, sourceId: REQ_ISSUE_4 },
        ),
      ),
      uow.run(() =>
        inventoryService.issueOut(
          { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
          { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('30'), allowNegative: false, sourceId: REQ_ISSUE_5 },
        ),
      ),
    ]);
    const [bal] = await ds.query(
      `SELECT quantity_on_hand::text AS q FROM stock_balance WHERE company_id=$1 AND godown_id=$2 AND item_id=$3`,
      [CO, GODOWN_A, ITEM],
    );
    // 100 - 20 - 30 = 50, regardless of interleaving order — no lost update.
    expect(bal.q).toBe('50.0000');
  });

  it('AC: no new HTTP endpoint — InventoryModule controllers are unchanged by this brief', () => {
    const controllers: unknown[] = Reflect.getMetadata('controllers', InventoryModule) ?? [];
    expect(controllers).not.toContain(InventoryServiceAdapter);
    expect(controllers.map((c) => (c as { name: string }).name)).toEqual(
      expect.arrayContaining(['StockLedgerController', 'StockJournalController']),
    );
    expect(controllers).toHaveLength(2); // exactly the two brief-1/-2 controllers — nothing added
  });

  it('AC: reconciliation across paths — receipt-in (port) + issue-out (port, posted) + Stock-Journal transfer (brief 2) reconcile (FR-INV-005)', async () => {
    // receipt-in via the port (PUR's future path) — 100 @ 520 = 52000; PUR's own Dr Inventory/Cr AP
    // posting is out of this brief's scope, so it is seeded directly to complete the GL picture.
    await uow.run(() =>
      inventoryService.receiveIn(
        { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
        { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('100'), rate: new Decimal('520'), sourceId: GRN_6 },
      ),
    );
    await seedReceiptGl('52000.0000');

    // issue-out via the port + caller-posted consumption (REQ's future path) — out 20 @ 520 = 10400
    await uow.run(async () => {
      const { issuedValue, rate } = await inventoryService.issueOut(
        { companyId: CO, voucherDate: '2026-07-15', postedBy: USER },
        { godownId: GODOWN_A, itemId: ITEM, qty: new Decimal('20'), allowNegative: false, sourceId: REQ_ISSUE_6 },
      );
      await posting.post(await buildConsumptionCommand(REQ_ISSUE_6, issuedValue, rate));
    });

    // a same-account Stock-Journal transfer (brief 2) — value-neutral, no ledger entry, both godowns share ACCT_INV
    const { id } = await createUc.execute(
      {
        voucherDate: '2026-07-15',
        mode: 'TRANSFER',
        fromGodownId: GODOWN_A,
        toGodownId: GODOWN_B,
        itemId: ITEM,
        quantity: '30',
        projectId: PROJECT,
        costCentreId: CC,
        purposeId: PURPOSE,
      },
      actor,
    );
    await approveUc.execute(id, actor);
    await postUc.execute(id, {}, actor);

    const ledger = await ledgerQuery.stockLedger({ itemId: ITEM }, actor);
    const sumStock = ledger.items.reduce((s, r) => s.plus(new Decimal(r.totalValue)), new Decimal(0));
    // 52000 (receipt) - 10400 (issue) = 41600; the transfer is value-neutral (no net change).
    expect(sumStock.toFixed(4)).toBe('41600.0000');

    const [{ bal }] = await ds.query(
      `SELECT COALESCE(SUM(debit - credit),0)::numeric(18,4)::text AS bal FROM journal_line WHERE account_id = $1`,
      [ACCT_INV],
    );
    // GL: Dr 52000 (receipt, seeded per the note above) - Cr 10400 (consumption, posted through the real
    // PostingService) = 41600 net debit — exactly the stock-ledger total. The invariant holds.
    expect(bal).toBe('41600.0000');
    expect(sumStock.toFixed(4)).toBe(bal);
  });
});
