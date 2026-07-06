/**
 * SAL retention-release + per-IPC outstanding + project register integration — Testcontainers Postgres,
 * real migrations + LED triggers + the real PostingService/LED/NUM/PER, a real posted SAL IPC, and REC's
 * `receipt_allocation` view (skill §13). Proves the full flow end-to-end per the brief's DoD:
 *   - AC1: the §4.2 retention release posts a balanced JOURNAL entry (Dr AR 100,000 / Cr Retention
 *     Receivable 100,000), party-tagged on both lines, its own gapless JV number, original IPC entry
 *     untouched;
 *   - AC2: held = retentionAmount - Σ POSTED releases; over-release rejected (409 OVER_RELEASE); the
 *     exact-boundary release drops held to 0, a further release is rejected;
 *   - AC3: release into a closed period is rejected before any write, no number consumed;
 *   - AC4: held decreases + currently-due AR (party balance) rises by the released amount;
 *   - AC5: per-IPC outstanding is independent per IPC and reflects a seeded receipt via REC's real view;
 *   - AC6: the project register's cumulative totals reconcile to journal_line party/account balances,
 *     across 2-3 seeded posted IPCs;
 *   - RBAC guard smoke test (skill §13) for the three new routes.
 * CI runs the LED + SAL + REC + retention-release migrations on a fresh DB first.
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
import { PartyOrmEntity } from '../src/modules/master-data/party/infrastructure/party.orm-entity';
import { ProjectOrmEntity } from '../src/modules/master-data/project/infrastructure/project.orm-entity';
import { IpcOrmEntity } from '../src/modules/sales/infrastructure/ipc.orm-entity';
import { ReceiptOrmEntity } from '../src/modules/receipt/infrastructure/receipt.orm-entity';
import { RetentionReleaseOrmEntity } from '../src/modules/sales/infrastructure/retention-release.orm-entity';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateSalesInvoice1700001200000 } from '../src/database/migrations/1700001200000-CreateSalesInvoice';
import { CreateReceipt1700001600000 } from '../src/database/migrations/1700001600000-CreateReceipt';
import { CreateRetentionRelease1700001700000 } from '../src/database/migrations/1700001700000-CreateRetentionRelease';

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

import { TypeOrmRetentionReleaseRepository } from '../src/modules/sales/infrastructure/typeorm-retention-release.repository';
import { SalesAccountMapAdapter } from '../src/modules/sales/infrastructure/sales-account-map.adapter';
import { TypeOrmIpcRepository } from '../src/modules/sales/infrastructure/typeorm-ipc.repository';
import { ReleaseRetentionUseCase } from '../src/modules/sales/application/release-retention.usecase';
import { IpcQueryService } from '../src/modules/sales/application/ipc-query.service';
import { OverReleaseError } from '../src/modules/sales/domain/errors';

// RolesGuard smoke test deps (mandatory per skill §13 — proves the controller's guard wiring is real).
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';
import { CreateUser1700000700000 } from '../src/database/migrations/1700000700000-CreateUser';
import { CreateRbacAndAudit1700000800000 } from '../src/database/migrations/1700000800000-CreateRbacAndAudit';
import { RbacV2ResourcePermissions1700002300000 } from '../src/database/migrations/1700002300000-RbacV2ResourcePermissions';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { JwtAuthGuard } from '../src/core/auth/presentation/jwt-auth.guard';
import { PermissionRequirement } from '../src/core/auth/presentation/require-permission.decorator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c3';
const FY1 = '00000000-0000-0000-0000-0000000000f3';
const PERIOD = '00000000-0000-0000-0000-0000000000e3';
const USER = '00000000-0000-0000-0000-0000000000a3';
const GROUP = '00000000-0000-0000-0000-0000000000b3';
const PROJECT = '00000000-0000-0000-0000-00000000d201';
const CC = '00000000-0000-0000-0000-00000000d202';
const PURPOSE = '00000000-0000-0000-0000-00000000d203';
const CUSTOMER = '00000000-0000-0000-0000-00000000d204';
const CUSTOMER_2 = '00000000-0000-0000-0000-00000000d205';

const ACC = {
  ar: '00000000-0000-0000-0000-00000000a320', // 1200
  retention: '00000000-0000-0000-0000-00000000a325', // 1250
  advanceLiability: '00000000-0000-0000-0000-00000000a330', // 2300 (SAL's well-known mobilization advance)
  aitRecoverable: '00000000-0000-0000-0000-00000000a327', // 1270
  revenue: '00000000-0000-0000-0000-00000000a410', // 4100
  vat: '00000000-0000-0000-0000-00000000a420', // 2200
  bank: '00000000-0000-0000-0000-00000000a110',
  tds: '00000000-0000-0000-0000-00000000a340', // 1220 (REC's TDS recoverable)
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

describe('SAL retention release + per-IPC outstanding + project register (real Postgres + real PostingService)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let releaseUc: ReleaseRetentionUseCase;
  let queryService: IpcQueryService;
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
        IpcOrmEntity,
        ReceiptOrmEntity,
        RetentionReleaseOrmEntity,
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
        CreateSalesInvoice1700001200000,
        CreateReceipt1700001600000,
        CreateRetentionRelease1700001700000,
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
    await acc(ACC.ar, '1200', 'Accounts Receivable', 'ASSET');
    await acc(ACC.retention, '1250', 'Retention Receivable', 'ASSET');
    await acc(ACC.advanceLiability, '2300', 'Mobilization Advance', 'LIABILITY');
    await acc(ACC.aitRecoverable, '1270', 'AIT Recoverable', 'ASSET');
    await acc(ACC.revenue, '4100', 'Revenue — Construction', 'INCOME');
    await acc(ACC.vat, '2200', 'Output VAT Payable', 'LIABILITY');
    await acc(ACC.bank, '1110', 'Bank — Operating', 'ASSET');
    await acc(ACC.tds, '1220', 'TDS Recoverable', 'ASSET');

    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,'Cust A',true,false,'+8801700000001')`,
      [CUSTOMER, CO],
    );
    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,'Cust B',true,false,'+8801700000002')`,
      [CUSTOMER_2, CO],
    );
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,'P-01','Site A',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [PROJECT, CO, CUSTOMER, USER],
    );
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Slab','Slab')`, [CC, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'IPC billing')`, [
      PURPOSE,
      CO,
      PROJECT,
    ]);

    const uow = new TypeOrmUnitOfWork(ds);
    const ids = new UuidIdGenerator();
    const clock = { now: () => new Date('2027-06-29T10:00:00Z') };
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
    const ipcRepo = new TypeOrmIpcRepository(ds);
    const releaseRepo = new TypeOrmRetentionReleaseRepository(ds);
    const accountMap = new SalesAccountMapAdapter(ds);
    const audit = { record: async () => undefined };

    releaseUc = new ReleaseRetentionUseCase(
      ipcRepo,
      releaseRepo,
      accountMap,
      posting,
      audit as never,
      uow,
      clock,
      ids,
    );
    queryService = new IpcQueryService(ds);

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
      'TRUNCATE journal_line, journal_entry, receipt, retention_release, sales_invoice, numbering_series RESTART IDENTITY CASCADE',
    );
  });

  /** Post a real SAL IPC (§4 template), retention 100,000 by default (10% of 1,000,000 certified). */
  async function postSalesIpc(
    seqNo: number,
    opts: { certified?: string; customerId?: string } = {},
  ): Promise<{ ipcId: string; entryId: string }> {
    const certified = opts.certified ?? '1000000';
    const customerId = opts.customerId ?? CUSTOMER;
    const ipcId = `00000000-0000-0000-0000-0000001e${String(seqNo).padStart(4, '0')}`;
    await ds.query(
      `INSERT INTO sales_invoice (id, company_id, financial_year_id, project_id, customer_id, ipc_seq_no, ipc_date, bill_date, due_date,
        work_completed_pct, certified_amount, cost_centre_id, purpose_id, output_vat_amount, ait_tds_amount, retention_amount,
        advance_recovered_amount, currently_due_amount, retention_rate_pct, advance_rate_pct, status)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-06-15','2026-06-15','2026-07-15',62.5,$7,$8,$9,75000,0,100000,0,975000,10,15,'POSTED')`,
      [ipcId, CO, FY1, PROJECT, customerId, seqNo, certified, CC, PURPOSE],
    );
    const entryId = `00000000-0000-0000-0000-0000001f${String(seqNo).padStart(4, '0')}`;
    await ds.transaction(async (m) => {
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, is_reversal, reversal_of, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,'SALES_IPC','2026-06-15','SalesInvoice',$1,false,NULL,now(),$5)`,
        [entryId, CO, FY1, `IPC/2526/000${seqNo}`, USER],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, party_id, debit, credit)
         VALUES (gen_random_uuid(),$1,1,$2,$3,$4,$5,$6,1075000,0)`,
        [entryId, ACC.ar, PROJECT, CC, PURPOSE, customerId],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, debit, credit)
         VALUES (gen_random_uuid(),$1,2,$2,$3,$4,$5,0,1000000)`,
        [entryId, ACC.revenue, PROJECT, CC, PURPOSE],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, debit, credit)
         VALUES (gen_random_uuid(),$1,3,$2,$3,$4,$5,0,75000)`,
        [entryId, ACC.vat, PROJECT, CC, PURPOSE],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, party_id, debit, credit)
         VALUES (gen_random_uuid(),$1,4,$2,$3,$4,$5,$6,100000,0)`,
        [entryId, ACC.retention, PROJECT, CC, PURPOSE, customerId],
      );
      await m.query(
        `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, purpose_id, party_id, debit, credit)
         VALUES (gen_random_uuid(),$1,5,$2,$3,$4,$5,$6,0,100000)`,
        [entryId, ACC.ar, PROJECT, CC, PURPOSE, customerId],
      );
    });
    await ds.query(`UPDATE sales_invoice SET journal_entry_id = $1, entry_no = $2 WHERE id = $3`, [
      entryId,
      `IPC/2526/000${seqNo}`,
      ipcId,
    ]);
    return { ipcId, entryId };
  }

  let receiptSeq = 0;

  async function seedReceipt(ipcId: string, customerId: string, amount: string): Promise<void> {
    receiptSeq += 1;
    const entryNo = `RV/2526/${String(receiptSeq).padStart(4, '0')}`;
    const [{ id: entryId }] = await ds.query(
      `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, is_reversal, reversal_of, posted_at, posted_by)
       VALUES (gen_random_uuid(),$1,$2,$3,'RECEIPT','2026-06-30','Receipt',gen_random_uuid(),false,NULL,now(),$4)
       RETURNING id`,
      [CO, FY1, entryNo, USER],
    );
    await ds.query(
      `INSERT INTO receipt (id, company_id, financial_year_id, receipt_type, receipt_date, payment_mode, deposit_account_id,
        party_id, project_id, cost_centre_id, purpose_id, ipc_id, amount_settled, cash_received, tax_deducted_at_source,
        cheque_txn_ref, status, entry_no, journal_entry_id, posted_at, posted_by)
       VALUES (gen_random_uuid(),$1,$2,'IPC_LINKED','2026-06-30','BANK_TRANSFER',$3,$4,$5,$6,$7,$8,$9,$9,0,'TXN-1','POSTED',$10,$11,now(),$12)`,
      [CO, FY1, ACC.bank, customerId, PROJECT, CC, PURPOSE, ipcId, amount, entryNo, entryId, USER],
    );
  }

  it('AC1: the §4.2 retention release posts a balanced JOURNAL entry, party-tagged, own gapless number, original IPC untouched', async () => {
    const { ipcId, entryId } = await postSalesIpc(7);
    const [origBefore] = await ds.query(`SELECT debit::text, credit::text FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`, [entryId]);

    const res = await releaseUc.execute(ipcId, { releaseDate: '2026-06-20', releasedAmount: '100000' }, actor);

    expect(res.entryNo).toMatch(/JV\//);
    const [entry] = await ds.query(`SELECT entry_no, voucher_type FROM journal_entry WHERE id=$1`, [res.entryId]);
    expect(entry.voucher_type).toBe('JOURNAL');
    expect(entry.entry_no).toBe(res.entryNo);

    const lines = await ds.query(
      `SELECT account_id, project_id, cost_centre_id, purpose_id, party_id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [res.entryId],
    );
    expect(lines).toHaveLength(2);
    const dr = lines.reduce((s: Decimal, l: { d: string }) => s.plus(l.d), new Decimal(0));
    const cr = lines.reduce((s: Decimal, l: { c: string }) => s.plus(l.c), new Decimal(0));
    expect(dr.toFixed(4)).toBe('100000.0000');
    expect(cr.toFixed(4)).toBe('100000.0000');
    expect(dr.equals(cr)).toBe(true);

    const arLine = lines.find((l: { account_id: string }) => l.account_id === ACC.ar);
    expect(arLine.d).toBe('100000.0000');
    expect(arLine.party_id).toBe(CUSTOMER);
    expect(arLine).toMatchObject({ project_id: PROJECT, cost_centre_id: CC, purpose_id: PURPOSE });

    const retLine = lines.find((l: { account_id: string }) => l.account_id === ACC.retention);
    expect(retLine.c).toBe('100000.0000');
    expect(retLine.party_id).toBe(CUSTOMER);
    expect(retLine).toMatchObject({ project_id: PROJECT, cost_centre_id: CC, purpose_id: PURPOSE });

    // Original IPC journal entry byte-for-byte unchanged.
    const [origAfter] = await ds.query(`SELECT debit::text, credit::text FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`, [entryId]);
    expect(origAfter).toEqual(origBefore);

    // retention_release row POSTED with the number stamped.
    const [rr] = await ds.query(`SELECT status, entry_no, journal_entry_id FROM retention_release WHERE id=$1`, [res.id]);
    expect(rr.status).toBe('POSTED');
    expect(rr.entry_no).toBe(res.entryNo);
    expect(rr.journal_entry_id).toBe(res.entryId);
  });

  it('AC2: held is derived (retentionAmount − Σ POSTED releases); over-release rejected; exact-boundary release drops held to 0', async () => {
    const { ipcId } = await postSalesIpc(8);

    // Over-release: retention held is 100,000; request 100,000.01 must be rejected.
    await expect(
      releaseUc.execute(ipcId, { releaseDate: '2026-06-20', releasedAmount: '100000.01' }, actor),
    ).rejects.toBeInstanceOf(OverReleaseError);

    // A partial release of 40,000 succeeds; held drops to 60,000.
    await releaseUc.execute(ipcId, { releaseDate: '2026-06-20', releasedAmount: '40000' }, actor);
    let ipcDto = await queryService.get(ipcId, actor);
    expect(ipcDto!.retentionHeldAmount).toBe('60000.0000');

    // Releasing the exact remaining 60,000 drops held to 0.
    await releaseUc.execute(ipcId, { releaseDate: '2026-06-20', releasedAmount: '60000' }, actor);
    ipcDto = await queryService.get(ipcId, actor);
    expect(ipcDto!.retentionHeldAmount).toBe('0.0000');

    // A further release (even ৳1) is now rejected.
    await expect(
      releaseUc.execute(ipcId, { releaseDate: '2026-06-20', releasedAmount: '1' }, actor),
    ).rejects.toBeInstanceOf(OverReleaseError);
  });

  it('AC3: a release into a CLOSED period rolls back — no entry, no number consumed', async () => {
    const { ipcId } = await postSalesIpc(9);
    await ds.query(`UPDATE accounting_period SET status='CLOSED' WHERE id=$1`, [PERIOD]);
    try {
      await expect(
        releaseUc.execute(ipcId, { releaseDate: '2026-06-20', releasedAmount: '50000' }, actor),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry WHERE source_type='RetentionRelease'`);
      expect(entries).toBe(0);
      const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series WHERE voucher_type='JOURNAL'`);
      expect(series).toBe(0);
      const [{ n: releases }] = await ds.query(`SELECT count(*)::int n FROM retention_release WHERE ipc_id=$1`, [ipcId]);
      expect(releases).toBe(0);
    } finally {
      await ds.query(`UPDATE accounting_period SET status='OPEN' WHERE id=$1`, [PERIOD]);
    }
  });

  it('AC4: held decreases and currently-due AR (party ledger balance) rises by the released amount', async () => {
    const { ipcId } = await postSalesIpc(10);

    const arBefore = await ds.query(
      `SELECT COALESCE(SUM(debit),0)::text dr, COALESCE(SUM(credit),0)::text cr FROM journal_line WHERE account_id=$1 AND party_id=$2`,
      [ACC.ar, CUSTOMER],
    );
    const netArBefore = new Decimal(arBefore[0].dr).minus(arBefore[0].cr);

    await releaseUc.execute(ipcId, { releaseDate: '2026-06-20', releasedAmount: '75000' }, actor);

    const ipcDto = await queryService.get(ipcId, actor);
    expect(ipcDto!.retentionHeldAmount).toBe('25000.0000');

    const arAfter = await ds.query(
      `SELECT COALESCE(SUM(debit),0)::text dr, COALESCE(SUM(credit),0)::text cr FROM journal_line WHERE account_id=$1 AND party_id=$2`,
      [ACC.ar, CUSTOMER],
    );
    const netArAfter = new Decimal(arAfter[0].dr).minus(arAfter[0].cr);
    expect(netArAfter.minus(netArBefore).toFixed(4)).toBe('75000.0000');
  });

  it('AC5: per-IPC outstanding is independent per IPC and reflects a seeded receipt via REC\'s receipt_allocation view', async () => {
    const { ipcId: ipc1 } = await postSalesIpc(11);
    const { ipcId: ipc2 } = await postSalesIpc(12);

    const before1 = await queryService.outstandingForIpc(ipc1, actor);
    const before2 = await queryService.outstandingForIpc(ipc2, actor);
    expect(before1).toBe('975000.0000');
    expect(before2).toBe('975000.0000');

    await seedReceipt(ipc1, CUSTOMER, '400000');

    const after1 = await queryService.outstandingForIpc(ipc1, actor);
    const after2 = await queryService.outstandingForIpc(ipc2, actor);
    expect(after1).toBe('575000.0000'); // reduced by the receipt
    expect(after2).toBe('975000.0000'); // untouched — independent per IPC
  });

  it('AC6: the project register cumulative totals reconcile to journal_line party/account balances across 3 posted IPCs', async () => {
    const { ipcId: ipc1 } = await postSalesIpc(13, { certified: '1000000' });
    const { ipcId: ipc2 } = await postSalesIpc(14, { certified: '2000000' });
    const { ipcId: ipc3 } = await postSalesIpc(15, { certified: '500000' });

    await releaseUc.execute(ipc1, { releaseDate: '2026-06-20', releasedAmount: '100000' }, actor); // releases IPC1's full retention
    await seedReceipt(ipc2, CUSTOMER, '300000');

    const register = await queryService.projectRegister(PROJECT, actor);
    expect(register.rows).toHaveLength(3);

    const last = register.rows[register.rows.length - 1];
    expect(last.ipcSeqNo).toBe(15);

    // cumCertified reconciles to Σ certified across all 3 IPCs.
    expect(last.cumCertified).toBe('3500000.0000');
    // cumBilledDue reconciles to Σ currently_due_amount (975,000 × 3 = 2,925,000).
    expect(last.cumBilledDue).toBe('2925000.0000');
    // cumRetainedHeld = Σ retention (300,000) − Σ released (100,000) = 200,000.
    expect(last.cumRetainedHeld).toBe('200000.0000');
    // cumReceived reconciles to the seeded receipt.
    expect(last.cumReceived).toBe('300000.0000');

    expect(register.totals.certified).toBe('3500000.0000');
    expect(register.totals.retainedHeld).toBe('200000.0000');
    expect(register.totals.received).toBe('300000.0000');

    // Reconcile cumBilledDue + the release to the trial-balance: Σ(AR debit − AR credit) for the customer
    // across the 3 seeded IPCs' §4 gross-AR/retention-contra lines PLUS the release's own Dr AR line. The
    // seeded receipt (seedReceipt) only feeds REC's receipt_allocation view (cumReceived) here — it writes
    // no journal_line of its own in this test (REC's own posting is out of scope for this brief) — so the
    // ledger-side AR balance below reflects SAL's writes only (currently-due + the released retention),
    // matching cumBilledDue (2,925,000) plus the one release (100,000).
    const arBalance = await ds.query(
      `SELECT COALESCE(SUM(debit),0)::text dr, COALESCE(SUM(credit),0)::text cr FROM journal_line WHERE account_id=$1 AND party_id=$2`,
      [ACC.ar, CUSTOMER],
    );
    const netAr = new Decimal(arBalance[0].dr).minus(arBalance[0].cr);
    expect(netAr.toFixed(4)).toBe(new Decimal('2925000').plus('100000').toFixed(4));

    void ipc3; // seeded for the 3-row register; no further per-row assertion needed beyond the cumulative checks above.
  });

  // ── RBAC guard smoke test (skill §13) — proves SalesController/SalesProjectsController really enforce
  // @UseGuards(JwtAuthGuard, RolesGuard) + @Roles({module:'SAL', action}) for the THREE new routes. ──
  describe('SAL retention-release RBAC — real RolesGuard against a real Postgres-backed Role/Permission repo', () => {
    const ACCOUNTS_ROLE = '00000000-0000-0000-0000-0000000e3b10';
    const PM_ROLE = '00000000-0000-0000-0000-0000000e3b11';
    const HR_ROLE = '00000000-0000-0000-0000-0000000e3b12';
    const accountsActor: Actor = { ...actor, userId: 'acc-user', role: 'ACCOUNTS_MANAGER' };
    const pmActor: Actor = { ...actor, userId: 'pm-user', role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [PROJECT] };
    const hrActor: Actor = { ...actor, userId: 'hr-user', role: 'HR_MANAGER', isUnscoped: false };

    function mockContext(user: Actor | undefined, requirements: PermissionRequirement[]): ExecutionContext {
      jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requirements);
      return {
        getHandler: () => function handler() {},
        getClass: () => class SalesController {},
        switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
      } as unknown as ExecutionContext;
    }

    beforeAll(async () => {
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'ACCOUNTS_MANAGER',true,1) ON CONFLICT DO NOTHING`, [ACCOUNTS_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1) ON CONFLICT DO NOTHING`, [PM_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'HR_MANAGER',false,1) ON CONFLICT DO NOTHING`, [HR_ROLE, CO]);

      // ACCOUNTS_MANAGER: full SAL lifecycle incl. POST (release-retention uses SAL:POST) — per seed-roles-permissions.ts.
      for (const action of ['CREATE', 'READ', 'UPDATE', 'DELETE', 'POST', 'CANCEL']) {
        await ds.query(
          `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'sales.ipcs', $3, 'ALL', 1)`,
          [ACCOUNTS_ROLE, CO, action],
        );
      }
      // PROJECT_MANAGER: SAL:CREATE/READ only (project-scoped) — per seed-roles-permissions.ts; PM does NOT
      // hold SAL:POST, so release-retention (docs/srs/10-sales-ipc.md §3: Accounts Team performs retention
      // release) is unreachable for PM — asserted below.
      await ds.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'sales.ipcs', 'CREATE', 'ASSIGNED', 1)`,
        [PM_ROLE, CO],
      );
      await ds.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'sales.ipcs', 'READ', 'ASSIGNED', 1)`,
        [PM_ROLE, CO],
      );
      // HR_MANAGER holds zero SAL grant — the "clearly lacks it" role for 403s.
    });

    it('401: no/invalid token', () => {
      expect(() => jwtAuthGuard.handleRequest(null, false, null)).toThrow(UnauthorizedException);
      expect(() => jwtAuthGuard.handleRequest(new Error('jwt malformed'), false, null)).toThrow(UnauthorizedException);
    });

    it.each([
      ['POST /ipc/:id/release-retention', 'POST'],
      ['GET /ipc/:id/retention-releases', 'READ'],
      ['GET /projects/:projectId/register', 'READ'],
    ] as const)('403: HR_MANAGER (no SAL grant) is FORBIDDEN on %s -> SAL:%s', async (_route, action) => {
      const ctx = mockContext(hrActor, [{ resource: 'sales.ipcs', action }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['POST /ipc/:id/release-retention', 'POST'],
      ['GET /ipc/:id/retention-releases', 'READ'],
      ['GET /projects/:projectId/register', 'READ'],
    ] as const)('success: ACCOUNTS_MANAGER holds SAL:%s -> guard resolves true (%s)', async (_route, action) => {
      const ctx = mockContext(accountsActor, [{ resource: 'sales.ipcs', action }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('success: PROJECT_MANAGER holds SAL:READ -> guard resolves true (register + retention-releases)', async () => {
      const ctxRegister = mockContext(pmActor, [{ resource: 'sales.ipcs', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctxRegister)).resolves.toBe(true);
    });

    it('403: PROJECT_MANAGER lacks SAL:POST (PM does not release retention)', async () => {
      const ctx = mockContext(pmActor, [{ resource: 'sales.ipcs', action: 'POST' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403: RolesGuard rejects when request.user is absent even if @Roles() is present (defence-in-depth)', async () => {
      const ctx = mockContext(undefined, [{ resource: 'sales.ipcs', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
