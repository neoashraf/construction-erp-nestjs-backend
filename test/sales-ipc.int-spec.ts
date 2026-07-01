/**
 * SAL (Sales / IPC) integration — Testcontainers Postgres, real migrations + LED triggers + the real
 * PostingService/LED/NUM/PER (skill §13). Proves the full IPC post path end-to-end:
 *   - AC1: an IPC posts a balanced SALES_IPC entry (Σdr=Σcr=1,375,000 exact), revenue/VAT lines tagged
 *     project+cost_centre+purpose (no godown), AR/retention/advance lines carry the customer party;
 *   - AC5: DRAFT has no entry_no; post allocates a gapless SALES_IPC number; a rolled-back post (closed
 *     period) consumes NO number and leaves the IPC DRAFT;
 *   - AC9: a duplicate (project, ipc_seq_no) is rejected;
 *   - AC10: cancel writes a linked reversal, the original entry is byte-for-byte unchanged, the IPC number
 *     is retained, the IPC is CANCELLED; repost = reverse+post (original untouched, new number);
 *   - AC1/money: figures round-trip at numeric(18,4).
 * CI runs the LED + SAL migrations on a fresh DB first so the balance/append-only triggers + the CHECKs +
 * the (company,project,seq) unique index are genuinely exercised.
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
import { IpcOrmEntity } from '../src/modules/sales/infrastructure/ipc.orm-entity';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateSalesInvoice1700001200000 } from '../src/database/migrations/1700001200000-CreateSalesInvoice';

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

import { TypeOrmIpcRepository } from '../src/modules/sales/infrastructure/typeorm-ipc.repository';
import { SalesAccountMapAdapter } from '../src/modules/sales/infrastructure/sales-account-map.adapter';
import { IpcConfigAdapter } from '../src/modules/sales/infrastructure/ipc-config.adapter';
import { AdvanceBalanceAdapter } from '../src/modules/sales/infrastructure/advance-balance.adapter';
import { CreateIpcUseCase } from '../src/modules/sales/application/create-ipc.usecase';
import { PostIpcUseCase } from '../src/modules/sales/application/post-ipc.usecase';
import { CancelIpcUseCase } from '../src/modules/sales/application/cancel-ipc.usecase';
import { RepostIpcUseCase } from '../src/modules/sales/application/repost-ipc.usecase';
import { DuplicateSeqNoError } from '../src/modules/sales/domain/errors';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const PERIOD = '00000000-0000-0000-0000-0000000000e1';
const USER = '00000000-0000-0000-0000-0000000000a1';
const GROUP = '00000000-0000-0000-0000-0000000000b1';
const PROJECT = '00000000-0000-0000-0000-00000000d001';
const CC = '00000000-0000-0000-0000-00000000d002';
const PURPOSE = '00000000-0000-0000-0000-00000000d003';
const CUSTOMER = '00000000-0000-0000-0000-00000000d004';

const ACC = {
  ar: '00000000-0000-0000-0000-00000000a120', // 1200
  retention: '00000000-0000-0000-0000-00000000a125', // 1250
  advance: '00000000-0000-0000-0000-00000000a230', // 2300
  ait: '00000000-0000-0000-0000-00000000a127', // 1270
  revenue: '00000000-0000-0000-0000-00000000a410', // 4100
  vat: '00000000-0000-0000-0000-00000000a220', // 2200
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

const baseDraft = {
  projectId: PROJECT,
  ipcSeqNo: 7,
  ipcDate: '2025-07-15',
  billDate: '2025-07-15',
  dueDate: '2025-08-15',
  workCompletedPct: '62.5',
  certifiedAmount: '1000000',
  costCentreId: CC,
  purposeId: PURPOSE,
  aitTdsAmount: '50000',
};

describe('Sales / IPC (real Postgres + real PostingService)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let createIpc: CreateIpcUseCase;
  let postIpc: PostIpcUseCase;
  let cancelIpc: CancelIpcUseCase;
  let repostIpc: RepostIpcUseCase;

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
        IpcOrmEntity,
      ],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateLedger1700000400000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
        CreateSalesInvoice1700001200000,
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
      `INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES ($1,$2,$3,'Jul 2025','2025-07-01','2025-07-31','OPEN')`,
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
    await acc(ACC.ar, '1200', 'Accounts Receivable', 'ASSET');
    await acc(ACC.retention, '1250', 'Retention Receivable', 'ASSET');
    await acc(ACC.advance, '2300', 'Mobilization Advance', 'LIABILITY');
    await acc(ACC.ait, '1270', 'AIT Recoverable', 'ASSET');
    await acc(ACC.revenue, '4100', 'Revenue — Construction', 'INCOME');
    await acc(ACC.vat, '2200', 'Output VAT Payable', 'LIABILITY');

    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,'Cust A',true,false,'+8801700000000')`,
      [CUSTOMER, CO],
    );
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,'P-01','Site A',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [PROJECT, CO, CUSTOMER, USER],
    );
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Slab','Slab')`, [CC, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'IPC #7')`, [
      PURPOSE,
      CO,
      PROJECT,
    ]);

    const uow = new TypeOrmUnitOfWork(ds);
    const ids = new UuidIdGenerator();
    const clock = { now: () => new Date('2025-07-15T10:00:00Z') };
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
    const repo = new TypeOrmIpcRepository(ds);
    const accountMap = new SalesAccountMapAdapter(ds);
    const config = new IpcConfigAdapter();
    const advance = new AdvanceBalanceAdapter(ds);
    const audit = { record: async () => undefined };

    createIpc = new CreateIpcUseCase(repo, accountMap, config, advance, audit as never, uow, ids);
    postIpc = new PostIpcUseCase(repo, accountMap, advance, posting, audit as never, uow, clock);
    cancelIpc = new CancelIpcUseCase(repo, posting, audit as never, uow);
    repostIpc = new RepostIpcUseCase(repo, accountMap, config, advance, posting, audit as never, uow, clock);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await ds.query('TRUNCATE journal_line, journal_entry, sales_invoice, numbering_series RESTART IDENTITY CASCADE');
  });

  /**
   * Seed a mobilization-advance liability the IPC can recover against: a balanced 2-line ledger entry
   * crediting the advance account (party+project tagged) so AdvanceBalanceAdapter reads a positive
   * remaining. In production this is a REC advance receipt; here we insert it directly.
   */
  async function seedAdvanceLiability(amount: string): Promise<void> {
    const entryId = '00000000-0000-0000-0000-00000000e900';
    // Wrap in ONE transaction so the deferred balance trigger checks at commit (not per-INSERT).
    await ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, is_reversal, reversal_of, posted_at, posted_by)
         VALUES ($1,$2,$3,'SEED/1','RECEIPT','2025-07-10','Seed',$1,false,NULL,now(),$4)`,
        [entryId, CO, FY1, USER],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, party_id, debit, credit)
         VALUES ('00000000-0000-0000-0000-00000000e901',$1,1,$2,$3,$4,$5,$6,$7,0)`,
        [entryId, ACC.ar, PROJECT, CC, PURPOSE, CUSTOMER, amount],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, party_id, debit, credit)
         VALUES ('00000000-0000-0000-0000-00000000e902',$1,2,$2,$3,$4,$5,$6,0,$7)`,
        [entryId, ACC.advance, PROJECT, CC, PURPOSE, CUSTOMER, amount],
      );
    });
  }

  it('AC1/AC5: an IPC posts a balanced SALES_IPC entry, gapless number, dims + party', async () => {
    await seedAdvanceLiability('200000.0000'); // enough to cover the 150,000 recovery
    const { id } = await createIpc.execute(baseDraft, actor);
    // DRAFT has no number
    let [v] = await ds.query(`SELECT status, entry_no, currently_due_amount::text due FROM sales_invoice WHERE id=$1`, [id]);
    expect(v.status).toBe('DRAFT');
    expect(v.entry_no).toBeNull();
    expect(v.due).toBe('775000.0000'); // AC2 residual

    const res = await postIpc.execute(id, actor);

    const [entry] = await ds.query(`SELECT entry_no, voucher_type FROM journal_entry WHERE id=$1`, [res.entryId]);
    expect(entry.voucher_type).toBe('SALES_IPC');
    expect(entry.entry_no).toBe(res.entryNo);
    expect(res.entryNo).toMatch(/IPC\//); // gapless SALES_IPC number

    // balanced at exactly 1,375,000
    const [sum] = await ds.query(
      `SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`,
      [res.entryId],
    );
    expect(sum.dr).toBe(sum.cr);
    expect(sum.dr).toBe('1375000.0000');

    // revenue/VAT lines carry dims, no party, no godown
    const [rev] = await ds.query(
      `SELECT project_id, cost_centre_id, purpose_id, godown_id, party_id, credit::text c FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`,
      [res.entryId, ACC.revenue],
    );
    expect(rev).toMatchObject({ project_id: PROJECT, cost_centre_id: CC, purpose_id: PURPOSE, godown_id: null, party_id: null });
    expect(rev.c).toBe('1000000.0000');

    // AR / retention / advance control lines carry the customer party
    for (const accId of [ACC.ar, ACC.retention, ACC.advance]) {
      const rows = await ds.query(`SELECT party_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [
        res.entryId,
        accId,
      ]);
      for (const r of rows) expect(r.party_id).toBe(CUSTOMER);
    }

    // retention (debit) + advance (debit) exact
    const [ret] = await ds.query(`SELECT debit::text d FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [
      res.entryId,
      ACC.retention,
    ]);
    expect(ret.d).toBe('100000.0000');
    const [adv] = await ds.query(`SELECT debit::text d FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [
      res.entryId,
      ACC.advance,
    ]);
    expect(adv.d).toBe('150000.0000');

    // IPC POSTED with the number stamped
    [v] = await ds.query(`SELECT status, entry_no, journal_entry_id, posted_at, posted_by FROM sales_invoice WHERE id=$1`, [id]);
    expect(v.status).toBe('POSTED');
    expect(v.entry_no).toBe(res.entryNo);
    expect(v.journal_entry_id).toBe(res.entryId);
    expect(v.posted_by).toBe(USER);
  });

  it('AC5/AC6: a post into a CLOSED period rolls back — IPC DRAFT, no entry, no number consumed', async () => {
    const { id } = await createIpc.execute(baseDraft, actor);
    await ds.query(`UPDATE accounting_period SET status='CLOSED' WHERE id=$1`, [PERIOD]);
    try {
      await expect(postIpc.execute(id, actor)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
      expect(entries).toBe(0);
      const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series`);
      expect(series).toBe(0);
      const [v] = await ds.query(`SELECT status, entry_no FROM sales_invoice WHERE id=$1`, [id]);
      expect(v.status).toBe('DRAFT');
      expect(v.entry_no).toBeNull();
    } finally {
      await ds.query(`UPDATE accounting_period SET status='OPEN' WHERE id=$1`, [PERIOD]);
    }
  });

  it('AC9: a duplicate (project, ipc_seq_no) is rejected', async () => {
    await createIpc.execute(baseDraft, actor);
    await expect(createIpc.execute(baseDraft, actor)).rejects.toBeInstanceOf(DuplicateSeqNoError);
    const [{ n }] = await ds.query(`SELECT count(*)::int n FROM sales_invoice WHERE project_id=$1 AND ipc_seq_no=7`, [PROJECT]);
    expect(n).toBe(1);
  });

  it('AC1/money: figures round-trip at numeric(18,4)', async () => {
    const { id } = await createIpc.execute(
      { ...baseDraft, ipcSeqNo: 9, certifiedAmount: '1234567.8900', retentionAmount: '0', advanceRecoveredAmount: '0', aitTdsAmount: '0' },
      actor,
    );
    const res = await postIpc.execute(id, actor);
    // certified 1,234,567.8900 + VAT 7.5% = 92,592.5918 (round half-up) → gross AR
    const [rev] = await ds.query(`SELECT credit::text c FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [
      res.entryId,
      ACC.revenue,
    ]);
    expect(rev.c).toBe('1234567.8900');
    const [sum] = await ds.query(`SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`, [
      res.entryId,
    ]);
    expect(sum.dr).toBe(sum.cr);
  });

  it('AC10: cancel writes a linked reversal; original entry unchanged; number retained; IPC CANCELLED', async () => {
    const { id } = await createIpc.execute(baseDraft, actor);
    const posted = await postIpc.execute(id, actor);
    const before = await ds.query(
      `SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [posted.entryId],
    );

    const cancelled = await cancelIpc.execute(id, 'certified % corrected', actor);

    // original entry byte-for-byte unchanged
    const after = await ds.query(
      `SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [posted.entryId],
    );
    expect(after).toEqual(before);
    // a new linked reversal exists
    const [rev] = await ds.query(`SELECT id, is_reversal, reversal_of FROM journal_entry WHERE reversal_of=$1`, [posted.entryId]);
    expect(rev.is_reversal).toBe(true);
    expect(cancelled.reversalEntryId).toBe(rev.id);
    // IPC CANCELLED, original number retained
    const [v] = await ds.query(`SELECT status, entry_no, journal_entry_id FROM sales_invoice WHERE id=$1`, [id]);
    expect(v.status).toBe('CANCELLED');
    expect(v.entry_no).toBe(posted.entryNo);
    expect(v.journal_entry_id).toBe(posted.entryId); // still points at the ORIGINAL entry
  });

  it('AC10: repost = reverse + post; original entry untouched; new number; IPC re-stamped POSTED', async () => {
    const { id } = await createIpc.execute(baseDraft, actor);
    const posted = await postIpc.execute(id, actor);
    const before = await ds.query(
      `SELECT id, debit::text d FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [posted.entryId],
    );

    const reposted = await repostIpc.execute(id, { certifiedAmount: '2000000' }, 'measurement corrected', actor);

    // original entry unchanged
    const after = await ds.query(
      `SELECT id, debit::text d FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [posted.entryId],
    );
    expect(after).toEqual(before);
    // a reversal + a new corrected entry exist, each with its own number
    const [rev] = await ds.query(`SELECT id FROM journal_entry WHERE reversal_of=$1`, [posted.entryId]);
    expect(rev.id).toBe(reposted.reversalEntryId);
    expect(reposted.entryNo).not.toBe(posted.entryNo);
    expect(reposted.reversalEntryNo).not.toBe(posted.entryNo);
    // corrected entry balances at the new figures (certified 2,000,000 + VAT 150,000 → gross AR)
    const [sum] = await ds.query(`SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`, [
      reposted.entryId,
    ]);
    expect(sum.dr).toBe(sum.cr);
    // IPC re-stamped POSTED with the NEW entry
    const [v] = await ds.query(`SELECT status, entry_no, journal_entry_id, certified_amount::text cert FROM sales_invoice WHERE id=$1`, [id]);
    expect(v.status).toBe('POSTED');
    expect(v.entry_no).toBe(reposted.entryNo);
    expect(v.journal_entry_id).toBe(reposted.entryId);
    expect(v.cert).toBe('2000000.0000');
  });
});
