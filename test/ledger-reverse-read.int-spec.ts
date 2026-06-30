/**
 * LED reverse + read integration — Testcontainers Postgres (skill §13). Proves:
 *   - AC1: reverse writes ONE new linked entry (reversal_of), fresh entry_no, original row unchanged;
 *   - AC6: existsReversalOf drives entryById.reversedBy;
 *   - AC5: entries list (derived is_reversed) + company/PM scope;
 *   - AC7: lines account-ledger mode opening_balance + cross-row running_balance;
 *   - AC8: trial-balance grouped Dr/Cr/net with balanced totals (period precedence);
 *   - AC4: repost rollback leaves the original unreversed, no number consumed.
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
import { LedgerQueryService } from '../src/core/posting/read/ledger-query.service';
import { PostingCommand } from '../src/core/posting/domain/posting-command';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { Money } from '../src/common/money';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const PERIOD = '00000000-0000-0000-0000-0000000000e1';
const USER = '00000000-0000-0000-0000-0000000000a1';
const PROJECT = '00000000-0000-0000-0000-00000000d001';
const OTHER_PROJECT = '00000000-0000-0000-0000-00000000d099';
const ACCT_A = '00000000-0000-0000-0000-00000000d005';
const ACCT_B = '00000000-0000-0000-0000-00000000d006';

const admin: Actor = { userId: USER, companyId: CO, financialYearId: FY1, role: 'Admin', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };

function journal(dr: string, cr: string, amount: string, date: string, sourceId: string): PostingCommand {
  return {
    companyId: CO,
    financialYearId: FY1,
    voucherType: 'JOURNAL',
    voucherDate: date,
    sourceType: 'JV',
    sourceId,
    postedBy: USER,
    lines: [
      { accountId: dr, projectId: PROJECT, accountType: 'ASSET', debit: Money.of(amount), credit: Money.zero() },
      { accountId: cr, projectId: PROJECT, accountType: 'ASSET', debit: Money.zero(), credit: Money.of(amount) },
    ],
  };
}

describe('Ledger reverse + read (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let posting: PostingService;
  let query: LedgerQueryService;
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
      entities: [CompanyOrmEntity, FinancialYearOrmEntity, NumberingSeriesOrmEntity, AccountingPeriodOrmEntity, JournalEntryOrmEntity, JournalLineOrmEntity],
      migrations: [InitialBaseline1700000000000, CreateCompanyFinancialYear1700000100000, CreateNumberingSeries1700000200000, CreateAccountingPeriod1700000300000, CreateLedger1700000400000],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    await dataSource.query(`INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`, [CO]);
    await dataSource.query(`INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`, [FY1, CO]);
    await dataSource.query(`INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES ($1,$2,$3,'Jul 2025','2025-07-01','2025-07-31','OPEN')`, [PERIOD, CO, FY1]);

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
    query = new LedgerQueryService(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  // Seed: e1 (Dr A100/Cr B100 @07-10), e2 (Dr A50/Cr B50 @07-20), reverse e1.
  let e1: string;
  let e2: string;
  let reversalId: string;
  beforeAll(async () => {
    const r1 = await uow.run(() => posting.post(journal(ACCT_A, ACCT_B, '100.0000', '2025-07-10', '00000000-0000-0000-0000-000000000001')));
    e1 = r1.id;
    const r2 = await uow.run(() => posting.post(journal(ACCT_A, ACCT_B, '50.0000', '2025-07-20', '00000000-0000-0000-0000-000000000002')));
    e2 = r2.id;
    const rev = await uow.run(() => posting.reverse(e1, CO, 'correction', USER));
    reversalId = rev.id;
  });

  it('AC1: reverse writes one linked entry with a fresh number; original row unchanged', async () => {
    const [rev] = await dataSource.query(`SELECT entry_no, is_reversal, reversal_of FROM journal_entry WHERE id=$1`, [reversalId]);
    expect(rev).toMatchObject({ is_reversal: true, reversal_of: e1 });
    expect(rev.entry_no).toBe('JV/2526/0003');
    // original unchanged: still is_reversal=false, its lines intact (Dr A 100)
    const [orig] = await dataSource.query(`SELECT is_reversal FROM journal_entry WHERE id=$1`, [e1]);
    expect(orig.is_reversal).toBe(false);
    const [origLine] = await dataSource.query(`SELECT debit::text AS d FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [e1, ACCT_A]);
    expect(origLine.d).toBe('100.0000');
  });

  it('AC6: entryById exposes derived reversedBy', async () => {
    const detail = await query.entryById(e1, admin);
    expect(detail?.isReversed).toBe(true);
    expect(detail?.reversedBy).toEqual({ entryId: reversalId, entryNo: 'JV/2526/0003' });
    expect(detail?.lines).toHaveLength(2);
  });

  it('AC5/AC9: entries list is derived-reversed + company/PM scoped', async () => {
    const all = await query.entries({ financialYearId: FY1 }, admin);
    expect(all.total).toBe(3);
    const orig = all.items.find((e) => e.id === e1)!;
    expect(orig.isReversed).toBe(true);
    expect(orig.reversedByEntryId).toBe(reversalId);
    expect(orig.totalDebit).toBe('100.0000');

    // a PM scoped to a different project sees nothing
    const pm: Actor = { ...admin, role: 'PM', isUnscoped: false, assignedProjectIds: [OTHER_PROJECT] };
    const none = await query.entries({ financialYearId: FY1 }, pm);
    expect(none.total).toBe(0);
  });

  it('AC7/AC10: lines account-ledger mode returns opening + cumulative running balance (Decimal strings)', async () => {
    const res = await query.lines({ accountId: ACCT_A, dateFrom: '2025-07-01', dateTo: '2025-07-31' }, admin);
    expect(res.extraMeta?.openingBalance).toBe('0.0000');
    // chronological: 07-10 e1 Dr100 (→100), 07-10 reversal Cr100 (→0), 07-20 e2 Dr50 (→50)
    expect(res.items.map((l) => l.runningBalance)).toEqual(['100.0000', '0.0000', '50.0000']);
    expect(res.items[0].debit).toBe('100.0000');
  });

  it('AC8: trial-balance groups Dr/Cr/net with balanced totals', async () => {
    const tb = await query.trialBalance({ financialYearId: FY1, groupBy: 'account' }, admin);
    expect((tb.extraMeta as { totals: { debit: string; credit: string } }).totals).toEqual({ debit: '250.0000', credit: '250.0000' });
    const a = tb.items.find((r) => r.accountId === ACCT_A)!;
    expect(a).toMatchObject({ debit: '150.0000', credit: '100.0000', net: '50.0000' });
  });

  it('AC4: repost rollback leaves the original unreversed, no number consumed', async () => {
    const [{ last_sequence: before }] = await dataSource.query(`SELECT last_sequence FROM numbering_series WHERE voucher_type='JOURNAL'`);
    const bad = journal(ACCT_A, ACCT_B, '50.0000', '2025-07-20', '00000000-0000-0000-0000-000000000002');
    bad.lines[1].credit = Money.of('40.0000'); // imbalanced corrected post → fails
    await expect(uow.run(() => posting.repost(e2, CO, 'fix', USER, bad))).rejects.toThrow();

    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM journal_entry WHERE reversal_of=$1`, [e2]);
    expect(n).toBe(0); // e2 stays unreversed
    const [{ last_sequence: after }] = await dataSource.query(`SELECT last_sequence FROM numbering_series WHERE voucher_type='JOURNAL'`);
    expect(after).toBe(before); // no number consumed
  });
});
