/**
 * LED integration — Testcontainers Postgres, real migrations + triggers (skill §13). Proves the DB
 * integrity and the full post path:
 *   - AC1/AC7/AC8/AC13: PostingService.post inside a UoW persists a balanced, dimensioned, numbered entry;
 *   - AC2: the DEFERRED balance trigger rejects an unbalanced commit (direct insert);
 *   - AC3: the append-only trigger rejects UPDATE and DELETE on posted entry + line;
 *   - AC4: the line CHECK rejects both-sides-non-zero;
 *   - AC6: money round-trips at NUMERIC(18,4) precision;
 *   - AC12: a forced failure rolls back the entry, lines, AND the NUM counter (no number consumed).
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { NumberingSeriesOrmEntity } from '../src/core/numbering/infrastructure/numbering-series.orm-entity';
import { AccountingPeriodOrmEntity } from '../src/core/period/infrastructure/accounting-period.orm-entity';
import { JournalEntryOrmEntity } from '../src/core/posting/infrastructure/journal-entry.orm-entity';
import { JournalLineOrmEntity } from '../src/core/posting/infrastructure/journal-line.orm-entity';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
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
import { PostingCommand } from '../src/core/posting/domain/posting-command';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { getManager } from '../src/infrastructure/unit-of-work/transaction-context';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { Money } from '../src/common/money';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const PERIOD = '00000000-0000-0000-0000-0000000000e1';
const USER = '00000000-0000-0000-0000-0000000000a1';
const PROJECT = '00000000-0000-0000-0000-00000000d001';
const CC = '00000000-0000-0000-0000-00000000d002';
const PURPOSE = '00000000-0000-0000-0000-00000000d003';
const PARTY = '00000000-0000-0000-0000-00000000d004';
const ACCT_AR = '00000000-0000-0000-0000-00000000d005';
const ACCT_REV = '00000000-0000-0000-0000-00000000d006';

function salesIpc(sourceId: string, amount = '1000.0000'): PostingCommand {
  const dims = { projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE };
  return {
    companyId: CO,
    financialYearId: FY1,
    voucherType: 'SALES_IPC',
    voucherDate: '2025-07-15',
    sourceType: 'IPC',
    sourceId,
    postedBy: USER,
    lines: [
      { accountId: ACCT_AR, ...dims, isControlAccount: true, partyId: PARTY, debit: Money.of(amount), credit: Money.zero() },
      { accountId: ACCT_REV, ...dims, debit: Money.zero(), credit: Money.of(amount) },
    ],
  };
}

describe('Ledger & Posting Core (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let posting: PostingService;
  let uow: TypeOrmUnitOfWork;

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
      ],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateLedger1700000400000,
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    await dataSource.query(`INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`, [CO]);
    await dataSource.query(`INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`, [FY1, CO]);
    await dataSource.query(
      `INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES ($1,$2,$3,'Jul 2025','2025-07-01','2025-07-31','OPEN')`,
      [PERIOD, CO, FY1],
    );

    uow = new TypeOrmUnitOfWork(dataSource);
    const ids = new UuidIdGenerator();
    posting = new PostingService(
      new TypeOrmJournalEntryRepository(dataSource),
      new TypeOrmNumberingService(ids),
      new PeriodServiceImpl(new TypeOrmAccountingPeriodRepository(dataSource)),
      new OverviewTagMatrix(),
      new AllowAllProjectStatusService(),
      new AllowAllMasterLookupService(),
      ids,
      { now: () => new Date('2026-07-15T10:00:00Z') },
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await dataSource.query('TRUNCATE journal_line, journal_entry, numbering_series');
  });

  const post = (cmd: PostingCommand) => uow.run(() => posting.post(cmd));

  it('AC1/AC7/AC8/AC13: posts a balanced, dimensioned, numbered entry inside the UoW', async () => {
    const entry = await post(salesIpc('00000000-0000-0000-0000-000000000001'));
    expect(entry.props.entryNo).toBe('IPC/2526/0001');

    const [e] = await dataSource.query(`SELECT entry_no, voucher_type, posted_by, is_reversal, reversal_of FROM journal_entry WHERE id=$1`, [entry.id]);
    expect(e).toMatchObject({ entry_no: 'IPC/2526/0001', voucher_type: 'SALES_IPC', posted_by: USER, is_reversal: false, reversal_of: null });

    const [sum] = await dataSource.query(`SELECT SUM(debit)::text AS dr, SUM(credit)::text AS cr FROM journal_line WHERE journal_entry_id=$1`, [entry.id]);
    expect(sum.dr).toBe(sum.cr); // balanced at the DB
    const [ar] = await dataSource.query(`SELECT project_id, cost_centre_id, purpose_id, party_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [entry.id, ACCT_AR]);
    expect(ar).toMatchObject({ project_id: PROJECT, cost_centre_id: CC, purpose_id: PURPOSE, party_id: PARTY });
  });

  it('AC6: money round-trips at NUMERIC(18,4) precision', async () => {
    const entry = await post(salesIpc('00000000-0000-0000-0000-000000000002', '1234567.8901'));
    const [row] = await dataSource.query(`SELECT debit::text AS d FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [entry.id, ACCT_AR]);
    expect(row.d).toBe('1234567.8901');
  });

  it('AC2: the deferred balance trigger rejects an unbalanced commit', async () => {
    const entryId = '00000000-0000-0000-0000-00000000bbbb';
    await expect(
      uow.run(async () => {
        const m = getManager(dataSource);
        await m.query(`INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, posted_at, posted_by) VALUES ($1,$2,$3,'X/1','JOURNAL','2025-07-15','J','00000000-0000-0000-0000-0000000000aa', now(), $4)`, [entryId, CO, FY1, USER]);
        await m.query(`INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, debit, credit) VALUES (gen_random_uuid(), $1, 1, $2, 100, 0)`, [entryId, ACCT_AR]);
        // only one side; at COMMIT the deferred balance trigger raises
      }),
    ).rejects.toThrow();
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM journal_entry WHERE id=$1`, [entryId]);
    expect(n).toBe(0); // nothing persisted
  });

  it('AC3: append-only — UPDATE/DELETE on posted entry + line are rejected', async () => {
    const entry = await post(salesIpc('00000000-0000-0000-0000-000000000003'));
    await expect(dataSource.query(`UPDATE journal_entry SET narration='x' WHERE id=$1`, [entry.id])).rejects.toThrow();
    await expect(dataSource.query(`DELETE FROM journal_entry WHERE id=$1`, [entry.id])).rejects.toThrow();
    await expect(dataSource.query(`UPDATE journal_line SET debit=0 WHERE journal_entry_id=$1`, [entry.id])).rejects.toThrow();
    await expect(dataSource.query(`DELETE FROM journal_line WHERE journal_entry_id=$1`, [entry.id])).rejects.toThrow();
  });

  it('AC4: the line CHECK rejects a both-sides-non-zero line', async () => {
    const entry = await post(salesIpc('00000000-0000-0000-0000-000000000004'));
    await expect(
      dataSource.query(`INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, debit, credit) VALUES (gen_random_uuid(), $1, 99, $2, 100, 100)`, [entry.id, ACCT_AR]),
    ).rejects.toThrow();
  });

  it('AC12: a forced failure rolls back entry, lines, AND the NUM counter (no number consumed)', async () => {
    await post(salesIpc('00000000-0000-0000-0000-000000000005')); // last_sequence → 1
    await expect(
      uow.run(async () => {
        await posting.post(salesIpc('00000000-0000-0000-0000-000000000006'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM journal_entry`);
    expect(n).toBe(1); // only the first post survived
    const [{ last_sequence }] = await dataSource.query(`SELECT last_sequence FROM numbering_series`);
    expect(last_sequence).toBe(1); // counter unchanged — number NOT consumed

    const next = await post(salesIpc('00000000-0000-0000-0000-000000000007'));
    expect(next.props.entryNo).toBe('IPC/2526/0002'); // 0002 reused — no gap
  });
});
