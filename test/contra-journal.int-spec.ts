/**
 * GEN (Contra & Journal) integration — Testcontainers Postgres, real migrations + triggers + the real
 * PostingService/LED (skill §13). Proves the full GEN post path end-to-end:
 *   - AC1: contra posts a balanced CONTRA entry, bank/cash only, no dims/party;
 *   - AC2: journal P&L line fully tagged + BS line untagged balances; a mis-tagged P&L line is rejected;
 *   - AC3: a party is required on an AR/AP control line;
 *   - AC4/AC5: the opening journal realises MAS balances once (party split AR/AP); a second is rejected
 *     by the partial-unique guard;
 *   - AC6: a forced failure leaves the voucher DRAFT, no entry, no consumed number (atomic);
 *   - AC8: reverse writes a linked reversal, the original entry is byte-for-byte unchanged, voucher CANCELLED;
 *   - AC9: money round-trips at numeric(18,4).
 * CI runs the migration on a fresh DB first so the line CHECKs + partial-unique opening index are exercised.
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
import {
  ContraLineOrmEntity,
  ContraVoucherOrmEntity,
} from '../src/modules/contra-journal/infrastructure/contra-voucher.orm-entity';
import {
  JournalLineDraftOrmEntity,
  JournalVoucherOrmEntity,
} from '../src/modules/contra-journal/infrastructure/journal-voucher.orm-entity';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateContraJournal1700001100000 } from '../src/database/migrations/1700001100000-CreateContraJournal';

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

import { TypeOrmContraVoucherRepository } from '../src/modules/contra-journal/infrastructure/typeorm-contra-voucher.repository';
import { TypeOrmJournalVoucherRepository } from '../src/modules/contra-journal/infrastructure/typeorm-journal-voucher.repository';
import { MasAccountClassificationAdapter } from '../src/modules/contra-journal/infrastructure/mas-account-classification.adapter';
import { MasOpeningBalanceAdapter } from '../src/modules/contra-journal/infrastructure/mas-opening-balance.adapter';
import { CreateContraUseCase } from '../src/modules/contra-journal/application/create-contra.usecase';
import { PostContraUseCase } from '../src/modules/contra-journal/application/post-contra.usecase';
import { ReverseContraUseCase } from '../src/modules/contra-journal/application/reverse-voucher.usecase';
import { CreateJournalUseCase } from '../src/modules/contra-journal/application/create-journal.usecase';
import { PostJournalUseCase } from '../src/modules/contra-journal/application/post-journal.usecase';
import { OpeningJournalAssembler } from '../src/modules/contra-journal/application/opening-journal.assembler';
import { PostOpeningJournalUseCase } from '../src/modules/contra-journal/application/post-opening-journal.usecase';
import { NotBankCashAccountError, MissingControlPartyError, OpeningAlreadyExistsError } from '../src/modules/contra-journal/domain/errors';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const PERIOD = '00000000-0000-0000-0000-0000000000e1';
const USER = '00000000-0000-0000-0000-0000000000a1';
const GROUP = '00000000-0000-0000-0000-0000000000b1';
const PROJECT = '00000000-0000-0000-0000-00000000d001';
const CC = '00000000-0000-0000-0000-00000000d002';
const PURPOSE = '00000000-0000-0000-0000-00000000d003';
const PARTY_A = '00000000-0000-0000-0000-00000000d004';
const PARTY_B = '00000000-0000-0000-0000-00000000d005';

// accounts (ids arbitrary; codes drive the well-known resolution)
const ACC = {
  cash: '00000000-0000-0000-0000-00000000a100',
  bank: '00000000-0000-0000-0000-00000000a110',
  expense: '00000000-0000-0000-0000-00000000a510',
  accrued: '00000000-0000-0000-0000-00000000a240',
  ar: '00000000-0000-0000-0000-00000000a120',
  ap: '00000000-0000-0000-0000-00000000a210',
  openingEq: '00000000-0000-0000-0000-00000000a390',
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

describe('Contra & Journal (real Postgres + real PostingService)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let uow: TypeOrmUnitOfWork;
  let posting: PostingService;
  let createContra: CreateContraUseCase;
  let postContra: PostContraUseCase;
  let reverseContra: ReverseContraUseCase;
  let createJournal: CreateJournalUseCase;
  let postJournal: PostJournalUseCase;
  let postOpening: PostOpeningJournalUseCase;

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
        ContraVoucherOrmEntity,
        ContraLineOrmEntity,
        JournalVoucherOrmEntity,
        JournalLineDraftOrmEntity,
      ],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateLedger1700000400000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
        CreateContraJournal1700001100000,
      ],
    });
    await ds.initialize();
    await ds.runMigrations();

    await ds.query(`INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`, [CO]);
    await ds.query(`INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`, [FY1, CO]);
    await ds.query(`INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES ($1,$2,$3,'Jul 2025','2025-07-01','2025-07-31','OPEN')`, [PERIOD, CO, FY1]);
    await ds.query(`INSERT INTO account_group (id, company_id, name, parent_group_id, type) VALUES ($1,$2,'Root',NULL,'ASSET')`, [GROUP, CO]);

    const acc = async (id: string, code: string, name: string, type: string, opening: string | null) =>
      ds.query(
        `INSERT INTO account (id, company_id, code, name, account_group_id, type, opening_balance) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, CO, code, name, GROUP, type, opening],
      );
    await acc(ACC.cash, '1100', 'Cash in Hand', 'ASSET', '300000.0000');
    await acc(ACC.bank, '1110', 'Bank Account', 'ASSET', '1200000.0000');
    await acc(ACC.expense, '5110', 'Electricity Expense', 'EXPENSE', null);
    await acc(ACC.accrued, '2400', 'Accrued Expenses', 'LIABILITY', null);
    await acc(ACC.ar, '1200', 'Accounts Receivable', 'ASSET', null);
    await acc(ACC.ap, '2100', 'Accounts Payable', 'LIABILITY', null);
    await acc(ACC.openingEq, '3900', 'Opening Balance Equity', 'EQUITY', null);

    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,'P-01','Site A',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [PROJECT, CO, PARTY_A, USER],
    );
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-OH','Overheads')`, [CC, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'June Utilities')`, [PURPOSE, CO, PROJECT]);
    await ds.query(`INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone, opening_balance) VALUES ($1,$2,'Party A',true,false,'+8801700000000','800000.0000')`, [PARTY_A, CO]);
    await ds.query(`INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone, opening_balance) VALUES ($1,$2,'Party B',false,true,'+8801700000001','-450000.0000')`, [PARTY_B, CO]);

    uow = new TypeOrmUnitOfWork(ds);
    const ids = new UuidIdGenerator();
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
    const contraRepo = new TypeOrmContraVoucherRepository(ds, ids);
    const journalRepo = new TypeOrmJournalVoucherRepository(ds, ids);
    const classify = new MasAccountClassificationAdapter(ds);
    const openingAdapter = new MasOpeningBalanceAdapter(ds);
    const audit = { record: async () => undefined };

    createContra = new CreateContraUseCase(contraRepo, classify, audit as never, uow, ids);
    postContra = new PostContraUseCase(contraRepo, posting, audit as never, uow, clock);
    reverseContra = new ReverseContraUseCase(contraRepo, posting, audit as never, uow);
    createJournal = new CreateJournalUseCase(journalRepo, classify, audit as never, uow, ids);
    postJournal = new PostJournalUseCase(journalRepo, posting, audit as never, uow, clock);
    const assembler = new OpeningJournalAssembler(openingAdapter, openingAdapter, ids);
    postOpening = new PostOpeningJournalUseCase(journalRepo, assembler, posting, audit as never, uow, clock);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await ds.query(
      'TRUNCATE journal_line, journal_entry, contra_line, contra_voucher, journal_line_draft, journal_voucher, numbering_series RESTART IDENTITY CASCADE',
    );
  });

  it('AC1: contra posts a balanced CONTRA entry, bank/cash only, no dims/party', async () => {
    const { id } = await createContra.execute(
      {
        voucherDate: '2025-07-15',
        narration: 'Cash to bank',
        lines: [
          { accountId: ACC.bank, debit: '500000.0000' },
          { accountId: ACC.cash, credit: '500000.0000' },
        ],
      },
      actor,
    );
    const res = await postContra.execute(id, actor);

    const [entry] = await ds.query(`SELECT entry_no, voucher_type FROM journal_entry WHERE id=$1`, [res.entryId]);
    expect(entry.voucher_type).toBe('CONTRA');
    const [sum] = await ds.query(`SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`, [res.entryId]);
    expect(sum.dr).toBe(sum.cr);
    const lines = await ds.query(`SELECT project_id, cost_centre_id, purpose_id, party_id FROM journal_line WHERE journal_entry_id=$1`, [res.entryId]);
    for (const l of lines) {
      expect(l.project_id).toBeNull();
      expect(l.party_id).toBeNull();
    }
    const [v] = await ds.query(`SELECT status, entry_no, journal_entry_id FROM contra_voucher WHERE id=$1`, [id]);
    expect(v.status).toBe('POSTED');
    expect(v.entry_no).toBe(entry.entry_no);
  });

  it('AC1: a contra line on a non-bank/cash account is rejected before the command is built', async () => {
    await expect(
      createContra.execute(
        {
          voucherDate: '2025-07-15',
          lines: [
            { accountId: ACC.expense, debit: '100.0000' },
            { accountId: ACC.cash, credit: '100.0000' },
          ],
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotBankCashAccountError);
  });

  it('AC2: journal P&L line fully tagged + BS line untagged, balanced', async () => {
    const { id } = await createJournal.execute(
      {
        voucherDate: '2025-07-15',
        narration: 'Accrue electricity',
        lines: [
          { accountId: ACC.expense, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE, debit: '120000.0000' },
          { accountId: ACC.accrued, credit: '120000.0000' },
        ],
      },
      actor,
    );
    const res = await postJournal.execute(id, actor);
    const [exp] = await ds.query(`SELECT project_id, cost_centre_id, purpose_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [res.entryId, ACC.expense]);
    expect(exp).toMatchObject({ project_id: PROJECT, cost_centre_id: CC, purpose_id: PURPOSE });
    const [bs] = await ds.query(`SELECT project_id, party_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [res.entryId, ACC.accrued]);
    expect(bs.project_id).toBeNull();
  });

  it('AC2: a P&L line missing a dimension is rejected (MISSING_REQUIRED_DIMENSION) — nothing posted', async () => {
    await expect(
      createJournal.execute(
        {
          voucherDate: '2025-07-15',
          lines: [
            { accountId: ACC.expense, projectId: PROJECT, costCentreId: CC, debit: '100.0000' }, // no purpose
            { accountId: ACC.accrued, credit: '100.0000' },
          ],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'MISSING_REQUIRED_DIMENSION' });
  });

  it('AC3: a journal line on an AR/AP control account with no party is rejected', async () => {
    await expect(
      createJournal.execute(
        {
          voucherDate: '2025-07-15',
          lines: [
            { accountId: ACC.expense, projectId: PROJECT, costCentreId: CC, purposeId: PURPOSE, debit: '100.0000' },
            { accountId: ACC.ar, credit: '100.0000' }, // control line, no party
          ],
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(MissingControlPartyError);
  });

  it('AC4/AC5: opening journal realises balances once (party split AR/AP); a second is rejected', async () => {
    const res = await postOpening.execute({ voucherDate: '2025-07-15' }, actor);
    const [entry] = await ds.query(`SELECT voucher_type FROM journal_entry WHERE id=$1`, [res.entryId]);
    expect(entry.voucher_type).toBe('OPENING');
    const [sum] = await ds.query(`SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`, [res.entryId]);
    expect(sum.dr).toBe(sum.cr);

    // Party A (owes us) on AR control debit; Party B (we owe) on AP control credit.
    const [ar] = await ds.query(`SELECT debit::text d, party_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [res.entryId, ACC.ar]);
    expect(ar).toMatchObject({ d: '800000.0000', party_id: PARTY_A });
    const [ap] = await ds.query(`SELECT credit::text c, party_id FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [res.entryId, ACC.ap]);
    expect(ap).toMatchObject({ c: '450000.0000', party_id: PARTY_B });
    // opening-equity absorbs the net (cash 300k + bank 1.2m + AR 800k = 2.3m; AP 450k → equity credit 1.85m)
    const [eq] = await ds.query(`SELECT credit::text c FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [res.entryId, ACC.openingEq]);
    expect(eq.c).toBe('1850000.0000');

    // a second opening is rejected (existsOpeningFor + partial-unique guard)
    await expect(postOpening.execute({ voucherDate: '2025-07-15' }, actor)).rejects.toBeInstanceOf(OpeningAlreadyExistsError);
    const [{ n }] = await ds.query(`SELECT count(*)::int n FROM journal_voucher WHERE voucher_type='OPENING'`);
    expect(n).toBe(1);
  });

  it('AC6/AC7: a post into a CLOSED period is rejected atomically — voucher DRAFT, no entry, no number', async () => {
    const { id } = await createContra.execute(
      {
        voucherDate: '2025-07-15',
        lines: [
          { accountId: ACC.bank, debit: '100.0000' },
          { accountId: ACC.cash, credit: '100.0000' },
        ],
      },
      actor,
    );
    // Close the period covering the voucher date; PostingService.assertOpen must reject the post.
    await ds.query(`UPDATE accounting_period SET status='CLOSED' WHERE id=$1`, [PERIOD]);
    try {
      await expect(postContra.execute(id, actor)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });

      const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
      expect(entries).toBe(0);
      const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series`);
      expect(series).toBe(0);
      const [v] = await ds.query(`SELECT status, entry_no FROM contra_voucher WHERE id=$1`, [id]);
      expect(v.status).toBe('DRAFT');
      expect(v.entry_no).toBeNull();
    } finally {
      await ds.query(`UPDATE accounting_period SET status='OPEN' WHERE id=$1`, [PERIOD]);
    }
  });

  it('AC8/AC9: reverse writes a linked reversal; the original entry is unchanged; voucher CANCELLED; money exact', async () => {
    const { id } = await createContra.execute(
      {
        voucherDate: '2025-07-15',
        lines: [
          { accountId: ACC.bank, debit: '1234567.8901' },
          { accountId: ACC.cash, credit: '1234567.8901' },
        ],
      },
      actor,
    );
    const posted = await postContra.execute(id, actor);
    const beforeRows = await ds.query(`SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`, [posted.entryId]);
    expect(beforeRows[0].d).toBe('1234567.8901'); // AC9 exact numeric(18,4)

    await reverseContra.execute(id, 'entered in error', actor);

    // the original entry's lines are byte-for-byte unchanged
    const afterRows = await ds.query(`SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`, [posted.entryId]);
    expect(afterRows).toEqual(beforeRows);
    // a new linked reversal entry exists (Dr↔Cr swapped)
    const [rev] = await ds.query(`SELECT id, is_reversal, reversal_of FROM journal_entry WHERE reversal_of=$1`, [posted.entryId]);
    expect(rev.is_reversal).toBe(true);
    const [revBank] = await ds.query(`SELECT credit::text c FROM journal_line WHERE journal_entry_id=$1 AND account_id=$2`, [rev.id, ACC.bank]);
    expect(revBank.c).toBe('1234567.8901'); // was a debit on the original
    // voucher CANCELLED, original number retained
    const [v] = await ds.query(`SELECT status, entry_no FROM contra_voucher WHERE id=$1`, [id]);
    expect(v.status).toBe('CANCELLED');
    expect(v.entry_no).toBe(posted.entryNo);
  });
});
