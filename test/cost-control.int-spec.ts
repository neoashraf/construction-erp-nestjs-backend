/**
 * Cost Control integration — Testcontainers Postgres, real migrations + real ledger (FR-CC-004/006/
 * 007/009/015/016). Seeds posted journal entries via direct balanced inserts (the deferred balance
 * trigger validates each entry at commit) and asserts CC's read/advisory layer over them:
 *   - budget-vs-actual numbers (actual = Σ expense, variance, utilisation, status);
 *   - INCOME excluded from actual but counted in profitability revenue;
 *   - an unbudgeted pair reports UNBUDGETED with no alert;
 *   - over-budget clears after a reversal lowers actual (no stored flag);
 *   - a cross-project purpose is rejected (CROSS_PROJECT_DIMENSION);
 *   - project scope limits a PM's results.
 * CC owns no schema — this proves it reads LED + MAS correctly.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { TypeOrmCostControlReadRepository } from '../src/core/cost-control/infrastructure/typeorm-cost-control.read.repo';
import { CostControlQueryService } from '../src/core/cost-control/application/cost-control-query.service';
import { BudgetCheckServiceImpl } from '../src/core/cost-control/application/budget-check.service';
import { TagConsistencyServiceImpl } from '../src/core/cost-control/application/tag-consistency.service';
import { CrossProjectDimensionError } from '../src/core/cost-control/domain/errors';
import { Actor } from '../src/core/tenancy/tenant-context';
import Decimal from 'decimal.js';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY = '00000000-0000-0000-0000-0000000000f1';
const PROJ = '00000000-0000-0000-0000-0000000000a1';
const PROJ_B = '00000000-0000-0000-0000-0000000000a2';
const SLAB = '00000000-0000-0000-0000-0000000000b1';
const PLASTER = '00000000-0000-0000-0000-0000000000b2';
const OVERCC = '00000000-0000-0000-0000-0000000000b3';
const GRP_EXP = '00000000-0000-0000-0000-0000000000d0';
const GRP_INC = '00000000-0000-0000-0000-0000000000d1';
const GRP_AST = '00000000-0000-0000-0000-0000000000d2';
const ACC_EXP = '00000000-0000-0000-0000-0000000000e1';
const ACC_INC = '00000000-0000-0000-0000-0000000000e2';
const ACC_CASH = '00000000-0000-0000-0000-0000000000e3';
const CUSTOMER = '00000000-0000-0000-0000-0000000000c1';
const PM_USER = '00000000-0000-0000-0000-0000000000c2';
const PURPOSE_B = '00000000-0000-0000-0000-0000000000f9';

const admin: Actor = {
  userId: '00000000-0000-0000-0000-0000000000a0', companyId: CO, financialYearId: FY,
  role: 'Admin', isUnscoped: true, assignedProjectIds: [], approvalLimit: null,
};
const pm: Actor = {
  userId: PM_USER, companyId: CO, financialYearId: FY, role: 'PM',
  isUnscoped: false, assignedProjectIds: [PROJ_B], approvalLimit: null,
};

describe('Cost Control (real Postgres + ledger, FR-CC-004/006/007/009/015/016)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let query: CostControlQueryService;
  let budgetCheck: BudgetCheckServiceImpl;
  let tagConsistency: TagConsistencyServiceImpl;
  let seq = 0;

  /** Insert a balanced posted entry (header + lines) inside one transaction so the deferred balance
   *  trigger validates at commit. `lines` must balance (Σ debit = Σ credit). */
  async function seedEntry(
    voucherType: string,
    lines: Array<{ account: string; debit: string; credit: string; project?: string; costCentre?: string }>,
    opts: { isReversal?: boolean } = {},
  ): Promise<void> {
    seq += 1;
    const entryId = `10000000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
    await dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO journal_entry (id, company_id, financial_year_id, entry_no, voucher_type, voucher_date, source_type, source_id, is_reversal, posted_at, posted_by)
         VALUES ($1,$2,$3,$4,$5,'2025-08-01','TEST',$6,$7, now(), $8)`,
        [entryId, CO, FY, `CC/${seq}`, voucherType, entryId, opts.isReversal ?? false, admin.userId],
      );
      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        await m.query(
          `INSERT INTO journal_line (id, journal_entry_id, line_no, account_id, project_id, cost_centre_id, debit, credit)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
          [entryId, lineNo, l.account, l.project ?? null, l.costCentre ?? null, l.debit, l.credit],
        );
      }
    });
  }

  /** Dr expense[project,cc] / Cr cash — a posted expense against a (project, cost centre). */
  const seedExpense = (project: string, cc: string, amount: string, isReversal = false) =>
    seedEntry(
      'PURCHASE',
      [
        { account: ACC_EXP, debit: amount, credit: '0', project, costCentre: cc },
        { account: ACC_CASH, debit: '0', credit: amount },
      ],
      { isReversal },
    );

  /** A reversal lowering expense: Cr expense[project,cc] / Dr cash. */
  const seedExpenseReversal = (project: string, cc: string, amount: string) =>
    seedEntry('PURCHASE', [
      { account: ACC_EXP, debit: '0', credit: amount, project, costCentre: cc },
      { account: ACC_CASH, debit: amount, credit: '0' },
    ], { isReversal: true });

  /** Cr income[project,cc] / Dr cash — a posted revenue against a (project, cost centre). */
  const seedIncome = (project: string, cc: string, amount: string) =>
    seedEntry('SALES_IPC', [
      { account: ACC_INC, debit: '0', credit: amount, project, costCentre: cc },
      { account: ACC_CASH, debit: amount, credit: '0' },
    ]);

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
      entities: [],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateLedger1700000400000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    // ---- masters ----
    await dataSource.query(`INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`, [CO]);
    await dataSource.query(`INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`, [FY, CO]);
    const proj = (id: string, code: string) =>
      dataSource.query(
        `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status)
         VALUES ($1,$2,$3,$3,$4,$5,'2025-01-01','2026-12-31','ACTIVE')`,
        [id, CO, code, CUSTOMER, PM_USER],
      );
    await proj(PROJ, 'PROJ-A');
    await proj(PROJ_B, 'PROJ-B');
    const cc = (id: string, code: string) =>
      dataSource.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,$3,$3)`, [id, CO, code]);
    await cc(SLAB, 'SLAB');
    await cc(PLASTER, 'PLASTER');
    await cc(OVERCC, 'OVERCC');
    const grp = (id: string, name: string, type: string) =>
      dataSource.query(`INSERT INTO account_group (id, company_id, name, type) VALUES ($1,$2,$3,$4)`, [id, CO, name, type]);
    await grp(GRP_EXP, 'Expenses', 'EXPENSE');
    await grp(GRP_INC, 'Income', 'INCOME');
    await grp(GRP_AST, 'Assets', 'ASSET');
    const acc = (id: string, code: string, groupId: string, type: string) =>
      dataSource.query(`INSERT INTO account (id, company_id, code, name, account_group_id, type) VALUES ($1,$2,$3,$3,$4,$5)`, [id, CO, code, groupId, type]);
    await acc(ACC_EXP, 'EXP-1', GRP_EXP, 'EXPENSE');
    await acc(ACC_INC, 'INC-1', GRP_INC, 'INCOME');
    await acc(ACC_CASH, 'CASH-1', GRP_AST, 'ASSET');
    // a purpose owned by PROJ_B (for the cross-project rejection)
    await dataSource.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Foundation-B')`, [PURPOSE_B, CO, PROJ_B]);

    // ---- budgets ----
    const budget = (project: string, ccId: string, amount: string) =>
      dataSource.query(
        `INSERT INTO project_budget (id, company_id, project_id, cost_centre_id, budgeted_amount) VALUES (gen_random_uuid(),$1,$2,$3,$4)`,
        [CO, project, ccId, amount],
      );
    await budget(PROJ, SLAB, '1000000.0000'); // SLAB budgeted
    await budget(PROJ, OVERCC, '100000.0000'); // OVERCC budgeted (over-budget test)
    await budget(PROJ_B, SLAB, '400000.0000'); // PROJ_B budgeted (PM scope test)
    // PLASTER left unbudgeted deliberately.

    // ---- postings ----
    await seedExpense(PROJ, SLAB, '950000.0000'); // SLAB 95% → APPROACHING
    await seedIncome(PROJ, SLAB, '200000.0000'); // INCOME on same pair (excluded from actual)
    await seedExpense(PROJ, PLASTER, '5000.0000'); // unbudgeted pair
    await seedExpense(PROJ_B, SLAB, '100000.0000'); // PROJ_B spend (PM sees only this)

    const repo = new TypeOrmCostControlReadRepository(dataSource);
    query = new CostControlQueryService(repo);
    budgetCheck = new BudgetCheckServiceImpl(repo);
    tagConsistency = new TagConsistencyServiceImpl(repo);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  const rowFor = <T extends { projectId: string | null; costCentreId: string | null }>(
    items: T[],
    project: string,
    cc: string,
  ): T | undefined => items.find((r) => r.projectId === project && r.costCentreId === cc);

  it('budget-vs-actual: actual = Σ expense, variance, utilisation, status (FR-CC-006/007)', async () => {
    const page = await query.budgetVsActual({ projectId: PROJ }, admin);
    const slab = rowFor(page.items, PROJ, SLAB)!;
    expect(slab).toMatchObject({
      budgetedAmount: '1000000.0000',
      actualCost: '950000.0000', // income NOT included
      variance: '50000.0000',
      utilisationPct: '95.0000',
      status: 'APPROACHING',
    });
  });

  it('INCOME excluded from actual but counted in profitability revenue (FR-CC-009)', async () => {
    const prof = await query.profitability({ groupBy: 'project_cost_centre', projectId: PROJ }, admin);
    const slab = rowFor(prof.items, PROJ, SLAB)!;
    expect(slab).toMatchObject({ revenue: '200000.0000', cost: '950000.0000', profit: '-750000.0000' });
  });

  it('an unbudgeted pair reports UNBUDGETED with no alert (FR-CC-015)', async () => {
    const page = await query.budgetVsActual({ projectId: PROJ }, admin);
    const plaster = rowFor(page.items, PROJ, PLASTER)!;
    expect(plaster).toMatchObject({ budgetedAmount: null, actualCost: '5000.0000', variance: null, utilisationPct: null, status: 'UNBUDGETED' });

    const alerts = await query.alerts({ projectId: PROJ }, admin);
    expect(rowFor(alerts.items, PROJ, PLASTER)).toBeUndefined();
  });

  it('over-budget clears after a reversal lowers actual (FR-CC-016)', async () => {
    await seedExpense(PROJ, OVERCC, '120000.0000'); // 120% → OVER
    let alerts = await query.alerts({ projectId: PROJ }, admin);
    expect(rowFor(alerts.items, PROJ, OVERCC)).toMatchObject({ status: 'OVER' });

    await seedExpenseReversal(PROJ, OVERCC, '40000.0000'); // actual 80,000 → 80% → OK
    const bva = await query.budgetVsActual({ projectId: PROJ }, admin);
    expect(rowFor(bva.items, PROJ, OVERCC)).toMatchObject({ actualCost: '80000.0000', status: 'OK' });

    alerts = await query.alerts({ projectId: PROJ }, admin);
    expect(rowFor(alerts.items, PROJ, OVERCC)).toBeUndefined(); // no stored flag to unwind
  });

  it('a cross-project purpose is rejected (FR-CC-004)', async () => {
    // PURPOSE_B belongs to PROJ_B; a line tagged to PROJ with that purpose is inconsistent.
    await expect(
      tagConsistency.assertConsistent({ companyId: CO }, [{ projectId: PROJ, purposeId: PURPOSE_B }]),
    ).rejects.toBeInstanceOf(CrossProjectDimensionError);
    // the same purpose on its own project passes
    await expect(
      tagConsistency.assertConsistent({ companyId: CO }, [{ projectId: PROJ_B, purposeId: PURPOSE_B }]),
    ).resolves.toBeUndefined();
  });

  it('project scope limits a PM to assigned projects (FR-CC-016, F4)', async () => {
    const pmPage = await query.budgetVsActual({}, pm);
    // PM assigned only PROJ_B → sees the PROJ_B/SLAB row, none of PROJ's.
    expect(pmPage.items.every((r) => r.projectId === PROJ_B)).toBe(true);
    expect(rowFor(pmPage.items, PROJ_B, SLAB)).toMatchObject({ actualCost: '100000.0000', status: 'OK' });
    expect(rowFor(pmPage.items, PROJ, SLAB)).toBeUndefined();

    const adminPage = await query.budgetVsActual({}, admin);
    expect(rowFor(adminPage.items, PROJ, SLAB)).toBeDefined();
  });

  it('prospective budget-check is advisory: projects OVER without throwing (FR-CC-013/014)', async () => {
    const results = await budgetCheck.checkProspective({ companyId: CO }, [
      { projectId: PROJ, costCentreId: SLAB, amount: new Decimal('100000') }, // 950k + 100k = 1.05m → OVER
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'OVER' });
    expect(results[0]!.projectedUtilisationPct!.toFixed(4)).toBe('105.0000');
  });
});
