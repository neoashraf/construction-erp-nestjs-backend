/**
 * INV stock-ledger-core integration — Testcontainers Postgres, real migrations + triggers (skill §13,
 * brief #14). Exercises the append-only fact table, the locked weighted-average re-roll, the as-of-date
 * projection, the reconciliation invariant, and the projection reads against REAL Postgres:
 *   - AC append-only : UPDATE/DELETE of a posted stock_movement is rejected by the trigger (FR-INV-020);
 *   - AC locked re-roll: two concurrent appenders on the same (godown,item) serialise via SELECT … FOR
 *                        UPDATE — the second computes its average against the first's committed balance,
 *                        no lost update (FR-INV-010, design §5.4);
 *   - AC as-of-date  : balance as of a past voucher_date = the snapshot of the last movement ≤ that date
 *                        (FR-INV-021);
 *   - AC projection  : GET stock-ledger returns qty/value/weighted-average per (godown,item) from
 *                        movements; weightedAverageRate null when qty 0 (FR-INV-001/-004);
 *   - AC reconciliation: Σ stock-ledger totalValue over all (godown,item) equals a supplied inventory
 *                        account balance in journal_line (FR-INV-005);
 *   - AC no write path: appended-movement is the ONLY mutation path; no HTTP write endpoint exists.
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
import { StockMovementOrmEntity } from '../src/modules/inventory/infrastructure/stock-movement.orm-entity';
import { StockBalanceOrmEntity } from '../src/modules/inventory/infrastructure/stock-balance.orm-entity';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateStockMovementAndBalance1700001000000 } from '../src/database/migrations/1700001000000-CreateStockMovementAndBalance';

import { TypeOrmStockMovementRepository } from '../src/modules/inventory/infrastructure/typeorm-stock-movement.repository';
import { StockLedgerQueryService } from '../src/modules/inventory/application/stock-ledger-query.service';
import { StockMovement } from '../src/modules/inventory/domain/stock-movement';
import { applyReceipt, valueIssue } from '../src/modules/inventory/domain/valuation';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { getManager } from '../src/infrastructure/unit-of-work/transaction-context';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const USER = '00000000-0000-0000-0000-0000000000a1';
const CUSTOMER = '00000000-0000-0000-0000-0000000000b1';
const PM = '00000000-0000-0000-0000-0000000000b2';
const PROJECT = '00000000-0000-0000-0000-00000000d001';
const GODOWN_A = '00000000-0000-0000-0000-00000000d0a0';
const GODOWN_B = '00000000-0000-0000-0000-00000000d0b0';
const ITEM = '00000000-0000-0000-0000-00000000d012';
const ACCT_INV = '00000000-0000-0000-0000-00000000d005';
const ACCT_AP = '00000000-0000-0000-0000-00000000d006';

const actor: Actor = {
  userId: USER,
  companyId: CO,
  financialYearId: FY1,
  role: 'Admin',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const ACCT_GROUP = '00000000-0000-0000-0000-00000000d00a';
const DEFAULT_ACCT = '00000000-0000-0000-0000-00000000d00b';

let ids: UuidIdGenerator;

describe('INV stock-ledger core (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let uow: TypeOrmUnitOfWork;
  let repo: TypeOrmStockMovementRepository;
  let query: StockLedgerQueryService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    dataSource = new DataSource({
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
        StockMovementOrmEntity,
        StockBalanceOrmEntity,
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
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    // --- master data (FK targets) ---
    await dataSource.query(
      `INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`,
      [CO],
    );
    await dataSource.query(
      `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`,
      [FY1, CO],
    );
    await dataSource.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status)
         VALUES ($1,$2,'P-01','Tower A',$3,$4,'2025-07-01','2027-06-30','ACTIVE')`,
      [PROJECT, CO, CUSTOMER, PM],
    );
    await dataSource.query(
      `INSERT INTO godown (id, company_id, project_id, name) VALUES ($1,$2,$3,'Site A'),($4,$2,$3,'Site B')`,
      [GODOWN_A, CO, PROJECT, GODOWN_B],
    );
    await dataSource.query(
      `INSERT INTO account_group (id, company_id, name, type) VALUES ($1,$2,'Current Assets','ASSET')`,
      [ACCT_GROUP, CO],
    );
    await dataSource.query(
      `INSERT INTO account (id, company_id, code, name, account_group_id, type, is_active) VALUES ($1,$2,'1400','Inventory',$3,'ASSET',true)`,
      [DEFAULT_ACCT, CO, ACCT_GROUP],
    );
    await dataSource.query(
      `INSERT INTO item (id, company_id, code, name, base_uom, default_account_id, is_active) VALUES ($1,$2,'CEM','Cement','BAG',$3,true)`,
      [ITEM, CO, DEFAULT_ACCT],
    );

    ids = new UuidIdGenerator();
    uow = new TypeOrmUnitOfWork(dataSource);
    repo = new TypeOrmStockMovementRepository(dataSource, ids);
    query = new StockLedgerQueryService(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await dataSource.query('TRUNCATE stock_movement, stock_balance, journal_line, journal_entry CASCADE');
  });

  /** Append a movement inside a UoW, taking the locked balance first (mirrors the post path). */
  async function post(godownId: string, itemId: string, qty: string, rate: string, date: string) {
    return uow.run(async () => {
      const prev = await repo.currentBalanceForUpdate(CO, godownId, itemId);
      const after = applyReceipt(prev, new Decimal(qty), new Decimal(rate));
      const value = new Decimal(qty).times(new Decimal(rate));
      const m = StockMovement.create(
        {
          companyId: CO,
          godownId,
          itemId,
          sourceType: 'STOCK_JOURNAL',
          sourceId: ids.next(),
          direction: 'IN',
          quantity: new Decimal(qty),
          rate: new Decimal(rate),
          value,
          balanceAfter: after,
          voucherDate: date,
          postedBy: USER,
        },
        ids.next(),
        new Date(`${date}T09:00:00Z`),
      );
      await repo.append(m);
      return { after };
    });
  }

  async function postIssue(godownId: string, itemId: string, qty: string, date: string) {
    return uow.run(async () => {
      const prev = await repo.currentBalanceForUpdate(CO, godownId, itemId);
      const { issuedValue, rate, newBalance } = valueIssue(prev, new Decimal(qty), {
        allowNegative: false,
      });
      const m = StockMovement.create(
        {
          companyId: CO,
          godownId,
          itemId,
          sourceType: 'STOCK_JOURNAL',
          sourceId: ids.next(),
          direction: 'OUT',
          quantity: new Decimal(qty),
          rate,
          value: issuedValue,
          balanceAfter: newBalance,
          voucherDate: date,
          postedBy: USER,
        },
        ids.next(),
        new Date(`${date}T10:00:00Z`),
      );
      await repo.append(m);
      return { issuedValue, newBalance };
    });
  }

  it('append-only: UPDATE/DELETE of a posted stock_movement is rejected (FR-INV-020)', async () => {
    const { after } = await post(GODOWN_A, ITEM, '100', '500', '2026-06-01');
    expect(after.value.toFixed(4)).toBe('50000.0000');
    const [row] = await dataSource.query(`SELECT id FROM stock_movement LIMIT 1`);
    await expect(
      dataSource.query(`UPDATE stock_movement SET quantity = 1 WHERE id = $1`, [row.id]),
    ).rejects.toThrow();
    await expect(
      dataSource.query(`DELETE FROM stock_movement WHERE id = $1`, [row.id]),
    ).rejects.toThrow();
  });

  it('CHECKs reject qty<=0 and a bad direction', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO stock_movement (id, company_id, godown_id, item_id, source_type, source_id, direction, quantity, rate, value, balance_qty_after, balance_value_after, is_reversal, voucher_date, posted_at, posted_by)
         VALUES (gen_random_uuid(),$1,$2,$3,'STOCK_JOURNAL',gen_random_uuid(),'IN',0,1,0,0,0,false,'2026-06-01',now(),$4)`,
        [CO, GODOWN_A, ITEM, USER],
      ),
    ).rejects.toThrow();
    await expect(
      dataSource.query(
        `INSERT INTO stock_movement (id, company_id, godown_id, item_id, source_type, source_id, direction, quantity, rate, value, balance_qty_after, balance_value_after, is_reversal, voucher_date, posted_at, posted_by)
         VALUES (gen_random_uuid(),$1,$2,$3,'STOCK_JOURNAL',gen_random_uuid(),'SIDEWAYS',1,1,1,1,1,false,'2026-06-01',now(),$4)`,
        [CO, GODOWN_A, ITEM, USER],
      ),
    ).rejects.toThrow();
  });

  it('weighted-average projection from movements; rate null at qty 0 (FR-INV-001/-002/-004)', async () => {
    await post(GODOWN_A, ITEM, '100', '500', '2026-06-01'); // 100 @ 500
    await post(GODOWN_A, ITEM, '50', '520', '2026-06-02'); // → 150, 76000, avg 506.6667
    const page = await query.stockLedger({ godownId: GODOWN_A, itemId: ITEM }, actor);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].quantityOnHand).toBe('150.0000');
    expect(page.items[0].totalValue).toBe('76000.0000');
    expect(page.items[0].weightedAverageRate).toBe('506.6667');

    // issue everything → qty 0, rate null
    await postIssue(GODOWN_A, ITEM, '150', '2026-06-03');
    const page2 = await query.stockLedger({ godownId: GODOWN_A, itemId: ITEM }, actor);
    expect(page2.items[0].quantityOnHand).toBe('0.0000');
    expect(page2.items[0].weightedAverageRate).toBeNull();
  });

  it('as-of-date balance = the snapshot of the last movement <= date (FR-INV-021)', async () => {
    await post(GODOWN_A, ITEM, '100', '500', '2026-06-01'); // value 50000 after 06-01
    await post(GODOWN_A, ITEM, '50', '520', '2026-06-10'); // value 76000 after 06-10

    const asOf01 = await repo.balanceAsOf(CO, GODOWN_A, ITEM, '2026-06-05');
    expect(asOf01.qty.toString()).toBe('100');
    expect(asOf01.value.toFixed(4)).toBe('50000.0000');

    const ledgerAsOf = await query.stockLedger(
      { godownId: GODOWN_A, itemId: ITEM, asOfDate: '2026-06-05' },
      actor,
    );
    expect(ledgerAsOf.items[0].totalValue).toBe('50000.0000');
    expect(ledgerAsOf.items[0].asOfDate).toBe('2026-06-05');

    const latest = await query.stockLedger({ godownId: GODOWN_A, itemId: ITEM }, actor);
    expect(latest.items[0].totalValue).toBe('76000.0000');
  });

  it('movement history is chronological and traced to its source (FR-INV-004/-021)', async () => {
    await post(GODOWN_A, ITEM, '100', '500', '2026-06-01');
    await postIssue(GODOWN_A, ITEM, '40', '2026-06-02');
    const hist = await query.movements({ godownId: GODOWN_A, itemId: ITEM }, actor);
    expect(hist.items).toHaveLength(2);
    expect(hist.items[0].direction).toBe('IN');
    expect(hist.items[1].direction).toBe('OUT');
    expect(hist.items[1].sourceType).toBe('STOCK_JOURNAL');
    expect(hist.items[1].balanceQtyAfter).toBe('60.0000');
    // OUT valued at current avg 500 → 40·500 = 20000; balance value 50000-20000 = 30000
    expect(hist.items[1].value).toBe('20000.0000');
    expect(hist.items[1].balanceValueAfter).toBe('30000.0000');
  });

  it('locked re-roll: two concurrent appenders serialise, no lost update (FR-INV-010, §5.4)', async () => {
    await post(GODOWN_A, ITEM, '100', '500', '2026-06-01'); // start: 100 @ 500 = 50000

    // Fire two receipts concurrently; the FOR UPDATE lock must serialise them so the second reads the
    // first's committed balance. Final qty 100+50+50 = 200, value 50000+26000+27000 = 103000.
    await Promise.all([
      post(GODOWN_A, ITEM, '50', '520', '2026-06-02'),
      post(GODOWN_A, ITEM, '50', '540', '2026-06-02'),
    ]);

    const [bal] = await dataSource.query(
      `SELECT quantity_on_hand::text AS q, total_value::text AS v FROM stock_balance WHERE company_id=$1 AND godown_id=$2 AND item_id=$3`,
      [CO, GODOWN_A, ITEM],
    );
    expect(bal.q).toBe('200.0000');
    expect(bal.v).toBe('103000.0000');

    // the projection agrees (recomputed from movements — never trusts a possibly-stale cache)
    const page = await query.stockLedger({ godownId: GODOWN_A, itemId: ITEM }, actor);
    expect(page.items[0].totalValue).toBe('103000.0000');
    expect(page.items[0].quantityOnHand).toBe('200.0000');
  });

  it('reconciliation: Σ stock-ledger totalValue = inventory account balance in the GL (FR-INV-005)', async () => {
    // Two godowns receive stock; the matching GL posts Dr Inventory / Cr A/P for each receipt value.
    await post(GODOWN_A, ITEM, '100', '500', '2026-06-01'); // 50000
    await post(GODOWN_B, ITEM, '30', '520', '2026-06-01'); // 15600
    await postIssue(GODOWN_A, ITEM, '10', '2026-06-02'); // out 10·500 = 5000

    // GL side: net inventory movements = +50000 +15600 -5000 = 60600 debit balance on ACCT_INV.
    await seedGlEntry('50000.0000');
    await seedGlEntry('15600.0000');
    await seedGlIssue('5000.0000');

    const ledger = await query.stockLedger({}, actor);
    const sumStock = ledger.items.reduce((s, r) => s.plus(new Decimal(r.totalValue)), new Decimal(0));

    const [{ bal }] = await dataSource.query(
      `SELECT COALESCE(SUM(debit - credit),0)::numeric(18,4)::text AS bal FROM journal_line WHERE account_id = $1`,
      [ACCT_INV],
    );
    expect(sumStock.toFixed(4)).toBe('60600.0000');
    expect(bal).toBe('60600.0000');
    expect(sumStock.toFixed(4)).toBe(bal); // the invariant
  });

  it('no write path: the query service exposes only reads (FR-INV-004)', () => {
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(query)).filter(
      (n) => n !== 'constructor' && typeof (query as unknown as Record<string, unknown>)[n] === 'function',
    );
    // the read reads are present
    expect(surface).toEqual(expect.arrayContaining(['stockLedger', 'movements']));
    // NOTHING that mutates a balance — no append/insert/update/delete/save/post surface
    const mutators = surface.filter((n) => /append|insert|update|delete|save|post|write|create/i.test(n));
    expect(mutators).toEqual([]);
  });

  // --- GL helpers: a balanced Dr Inventory / Cr A/P (receipt) or Dr A/P / Cr Inventory (issue) ---
  async function seedGlEntry(value: string) {
    await insertBalancedEntry(ACCT_INV, ACCT_AP, value);
  }
  async function seedGlIssue(value: string) {
    await insertBalancedEntry(ACCT_AP, ACCT_INV, value); // credit inventory
  }
  async function insertBalancedEntry(drAccount: string, crAccount: string, value: string) {
    await uow.run(async () => {
      const m = getManager(dataSource); // the transactional manager — both lines commit together
      const eid = ids.next();
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, posted_at, posted_by)
           VALUES ($1,$2,$3,$4,'STOCK_JOURNAL','2026-06-02','StockJournal',$5, now(), $6)`,
        [eid, CO, FY1, `SJ/${eid.slice(0, 8)}`, ids.next(), USER],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, godown_id, debit, credit)
           VALUES ($1,$2,1,$3,$4,NULL,NULL,$5,$6,0)`,
        [ids.next(), eid, drAccount, PROJECT, GODOWN_A, value],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, godown_id, debit, credit)
           VALUES ($1,$2,2,$3,$4,NULL,NULL,$5,0,$6)`,
        [ids.next(), eid, crAccount, PROJECT, GODOWN_A, value],
      );
    });
  }
});
