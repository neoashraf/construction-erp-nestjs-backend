/**
 * REQ (Material Requisition) workflow integration — Testcontainers Postgres, real migrations (skill §13).
 * Proves the requisition WORKFLOW half end-to-end against real Postgres — NO ledger, NO stock (brief #18):
 *   - AC1: create a DRAFT (project + active CC + purpose + godown + ≥1 line); a cross-project godown →
 *     GODOWN_NOT_IN_PROJECT; a closed project → PROJECT_CLOSED; an inactive item → INACTIVE_MASTER_REFERENCE;
 *   - AC2/AC3: submit computes the estimate (from seeded stock movements) + selects the tier + allocates a
 *     requisitionNo; a PM approves a PM-tier requisition; a PM approving an ACCOUNTS-tier (escalated) one →
 *     APPROVAL_BEYOND_AUTHORITY; ACCOUNTS approves the escalated one;
 *   - reject requires a reason; close abandons the balance;
 *   - the balance-invariant CHECK fires on a forced bad write (issued + balance ≠ requested);
 *   - project scope: a PM cannot read another project's requisition (403).
 * CI runs the MAS/INV/REQ migrations on a fresh DB first so the CHECKs + FKs are genuinely exercised.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';

import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { ProjectOrmEntity } from '../src/modules/master-data/project/infrastructure/project.orm-entity';
import { CostCentreOrmEntity } from '../src/modules/master-data/cost-centre/infrastructure/cost-centre.orm-entity';
import { PurposeOrmEntity } from '../src/modules/master-data/purpose/infrastructure/purpose.orm-entity';
import { GodownOrmEntity } from '../src/modules/master-data/godown/infrastructure/godown.orm-entity';
import { ItemOrmEntity } from '../src/modules/master-data/item/infrastructure/item.orm-entity';
import { StockMovementOrmEntity } from '../src/modules/inventory/infrastructure/stock-movement.orm-entity';
import { RequisitionOrmEntity } from '../src/modules/requisition/infrastructure/requisition.orm-entity';
import { RequisitionLineOrmEntity } from '../src/modules/requisition/infrastructure/requisition-line.orm-entity';
import { RequisitionApprovalOrmEntity } from '../src/modules/requisition/infrastructure/requisition-approval.orm-entity';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateStockMovementAndBalance1700001000000 } from '../src/database/migrations/1700001000000-CreateStockMovementAndBalance';
import { CreateRequisition1700001400000 } from '../src/database/migrations/1700001400000-CreateRequisition';

import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { Actor } from '../src/core/tenancy/tenant-context';
import { AccessPolicy } from '../src/core/auth/domain/access-policy';

import { TypeOrmRequisitionRepository } from '../src/modules/requisition/infrastructure/typeorm-requisition.repository';
import { RequisitionMasterRefAdapter } from '../src/modules/requisition/infrastructure/requisition-master-ref.adapter';
import { IndicativeRateAdapter } from '../src/modules/requisition/infrastructure/indicative-rate.adapter';
import { ApprovalThresholdAdapter } from '../src/modules/requisition/infrastructure/approval-threshold.adapter';
import { LoggingNotificationAdapter } from '../src/modules/requisition/infrastructure/logging-notification.adapter';
import { CreateRequisitionUseCase } from '../src/modules/requisition/application/create-requisition.usecase';
import { SubmitRequisitionUseCase } from '../src/modules/requisition/application/submit-requisition.usecase';
import { ApproveRequisitionUseCase } from '../src/modules/requisition/application/approve-requisition.usecase';
import { RejectRequisitionUseCase } from '../src/modules/requisition/application/reject-requisition.usecase';
import { CloseRequisitionUseCase } from '../src/modules/requisition/application/close-requisition.usecase';
import { RequisitionQueryService } from '../src/modules/requisition/application/requisition-query.service';
import {
  ApprovalBeyondAuthorityError,
  MissingRejectReasonError,
} from '../src/modules/requisition/domain/errors';
import {
  ClosedProjectError,
  GodownNotInProjectError,
  InactiveMasterReferenceError,
} from '../src/common/errors/domain-error';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const PROJECT = '00000000-0000-0000-0000-00000000d001';
const PROJECT2 = '00000000-0000-0000-0000-00000000d0f2';
const CLOSED_PROJECT = '00000000-0000-0000-0000-00000000d0c9';
const CC = '00000000-0000-0000-0000-00000000d002';
const CC_INACTIVE = '00000000-0000-0000-0000-00000000d0c2';
const PURPOSE = '00000000-0000-0000-0000-00000000d003';
const GODOWN = '00000000-0000-0000-0000-00000000d004';
const GODOWN2 = '00000000-0000-0000-0000-00000000d0f4';
const ITEM = '00000000-0000-0000-0000-00000000d005';
const ITEM_INACTIVE = '00000000-0000-0000-0000-00000000d0c5';
const REQUESTER = '00000000-0000-0000-0000-0000000000a1';

// PM assigned to PROJECT, approval limit set (PM tier authority).
const pmActor: Actor = {
  userId: REQUESTER,
  companyId: CO,
  financialYearId: FY1,
  role: 'ProjectManager',
  isUnscoped: false,
  assignedProjectIds: [PROJECT],
  approvalLimit: new Decimal('100000'),
};
// PM assigned only to PROJECT2 — cannot see/approve PROJECT's requisition.
const pmOther: Actor = {
  ...pmActor,
  userId: '00000000-0000-0000-0000-0000000000a2',
  assignedProjectIds: [PROJECT2],
};
// Accounts — unscoped escalation authority.
const accountsActor: Actor = {
  userId: '00000000-0000-0000-0000-0000000000a3',
  companyId: CO,
  financialYearId: FY1,
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

describe('REQ requisition workflow (real Postgres, no ledger/stock)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let createReq: CreateRequisitionUseCase;
  let submitReq: SubmitRequisitionUseCase;
  let approveReq: ApproveRequisitionUseCase;
  let rejectReq: RejectRequisitionUseCase;
  let closeReq: CloseRequisitionUseCase;
  let query: RequisitionQueryService;

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
        ProjectOrmEntity,
        CostCentreOrmEntity,
        PurposeOrmEntity,
        GodownOrmEntity,
        ItemOrmEntity,
        StockMovementOrmEntity,
        RequisitionOrmEntity,
        RequisitionLineOrmEntity,
        RequisitionApprovalOrmEntity,
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
        CreateRequisition1700001400000,
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
    const CUSTOMER = '00000000-0000-0000-0000-00000000d0aa';
    const GROUP = '00000000-0000-0000-0000-00000000d0bb';
    const ACCOUNT = '00000000-0000-0000-0000-00000000d0cc';
    await ds.query(`INSERT INTO account_group (id, company_id, name, parent_group_id, type) VALUES ($1,$2,'Root',NULL,'ASSET')`, [GROUP, CO]);
    await ds.query(
      `INSERT INTO account (id, company_id, code, name, account_group_id, type, opening_balance) VALUES ($1,$2,'1400','Inventory',$3,'ASSET',NULL)`,
      [ACCOUNT, CO, GROUP],
    );

    const project = (id: string, code: string, status: string) =>
      ds.query(
        `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,$3,$3,$4,$5,'2025-07-01','2026-06-30',$6)`,
        [id, CO, code, CUSTOMER, REQUESTER, status],
      );
    await project(PROJECT, 'P-01', 'ACTIVE');
    await project(PROJECT2, 'P-02', 'ACTIVE');
    await project(CLOSED_PROJECT, 'P-CL', 'CLOSED');

    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name, is_active) VALUES ($1,$2,'CC-Slab','Slab',true)`, [CC, CO]);
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name, is_active) VALUES ($1,$2,'CC-Old','Old',false)`, [CC_INACTIVE, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Day 20 pour')`, [PURPOSE, CO, PROJECT]);
    await ds.query(`INSERT INTO godown (id, company_id, project_id, name, is_active) VALUES ($1,$2,$3,'G-Site-A',true)`, [GODOWN, CO, PROJECT]);
    await ds.query(`INSERT INTO godown (id, company_id, project_id, name, is_active) VALUES ($1,$2,$3,'G-Site-B',true)`, [GODOWN2, CO, PROJECT2]);
    await ds.query(
      `INSERT INTO item (id, company_id, code, name, base_uom, default_account_id, is_active) VALUES ($1,$2,'CEM','Cement','BAG',$3,true)`,
      [ITEM, CO, ACCOUNT],
    );
    await ds.query(
      `INSERT INTO item (id, company_id, code, name, base_uom, default_account_id, is_active) VALUES ($1,$2,'OLD','Old Item','BAG',$3,false)`,
      [ITEM_INACTIVE, CO, ACCOUNT],
    );

    // Seed a stock movement so the indicative rate resolves to 520 for (GODOWN, ITEM).
    await ds.query(
      `INSERT INTO stock_movement
         (id, company_id, godown_id, item_id, source_type, source_id, direction, quantity, rate, value,
          balance_qty_after, balance_value_after, avg_rate_after, is_reversal, voucher_date, posted_at, posted_by)
       VALUES ($1,$2,$3,$4,'Seed',$1,'IN','1000','520','520000','1000','520000','520',false,'2025-07-05',now(),$5)`,
      ['00000000-0000-0000-0000-00000000e001', CO, GODOWN, ITEM, REQUESTER],
    );

    const uow = new TypeOrmUnitOfWork(ds);
    const ids = new UuidIdGenerator();
    const clock = { now: () => new Date('2026-07-01T10:00:00Z') };
    const audit = { record: async () => undefined };
    const noopTagConsistency = { assertConsistent: async () => undefined };
    const noopBudget = { checkProspective: async () => [] };

    const repo = new TypeOrmRequisitionRepository(ds);
    const masters = new RequisitionMasterRefAdapter(ds);
    const rates = new IndicativeRateAdapter(ds);
    const thresholds = new ApprovalThresholdAdapter();
    const notify = new LoggingNotificationAdapter();
    const access = new AccessPolicy();

    createReq = new CreateRequisitionUseCase(
      repo, masters, rates, noopTagConsistency as never, noopBudget as never, access, audit as never, uow, ids,
    );
    submitReq = new SubmitRequisitionUseCase(
      repo, rates, thresholds, masters, notify, audit as never, uow, clock,
    );
    approveReq = new ApproveRequisitionUseCase(
      repo, thresholds, notify, audit as never, uow, clock, ids,
    );
    rejectReq = new RejectRequisitionUseCase(repo, thresholds, notify, audit as never, uow, clock, ids);
    closeReq = new CloseRequisitionUseCase(repo, notify, access, audit as never, uow, clock);
    query = new RequisitionQueryService(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await ds.query('TRUNCATE requisition_approval, requisition_line, requisition RESTART IDENTITY CASCADE');
  });

  const line = (qty: string) => ({ itemId: ITEM, requestedQuantity: qty });
  const baseCreate = (over: Record<string, unknown> = {}) => ({
    projectId: PROJECT,
    costCentreId: CC,
    purposeId: PURPOSE,
    fromGodownId: GODOWN,
    requiredDate: '2026-07-10',
    priority: 'HIGH' as const,
    lines: [line('80')],
    ...over,
  });

  it('AC1 — creates a DRAFT with issued=0/balance=requested', async () => {
    const { id } = await createReq.execute(baseCreate(), pmActor);
    const dto = await query.get(id, pmActor);
    expect(dto!.status).toBe('DRAFT');
    expect(dto!.lines[0].balanceQuantity).toBe('80.0000');
    expect(dto!.lines[0].issuedQuantity).toBe('0.0000');
    expect(dto!.lines[0].uom).toBe('BAG'); // resolved from item base UoM
  });

  it('AC1 — a godown of another project → GODOWN_NOT_IN_PROJECT', async () => {
    await expect(createReq.execute(baseCreate({ fromGodownId: GODOWN2 }), pmActor)).rejects.toBeInstanceOf(
      GodownNotInProjectError,
    );
  });

  it('AC1 — a CLOSED project → PROJECT_CLOSED', async () => {
    const pmClosed: Actor = { ...pmActor, assignedProjectIds: [CLOSED_PROJECT] };
    await expect(
      createReq.execute(baseCreate({ projectId: CLOSED_PROJECT, purposeId: PURPOSE, fromGodownId: null }), pmClosed),
    ).rejects.toBeInstanceOf(ClosedProjectError);
  });

  it('AC1 — an inactive item → INACTIVE_MASTER_REFERENCE', async () => {
    await expect(
      createReq.execute(baseCreate({ lines: [{ itemId: ITEM_INACTIVE, requestedQuantity: '5' }] }), pmActor),
    ).rejects.toBeInstanceOf(InactiveMasterReferenceError);
  });

  it('AC2/AC3 — submit estimates + selects PM tier, the assigned PM approves', async () => {
    const { id } = await createReq.execute(baseCreate(), pmActor); // 80 × 520 = 41,600 ≤ 100,000 → PM
    await submitReq.execute(id, pmActor);
    let dto = await query.get(id, pmActor);
    expect(dto!.status).toBe('SUBMITTED');
    expect(dto!.estimatedValue).toBe('41600.0000');
    expect(dto!.approvalTier).toBe('PM');
    expect(dto!.requisitionNo).toMatch(/^REQ-\d{6}$/);

    await approveReq.execute(id, 'looks good', pmActor);
    dto = await query.get(id, pmActor);
    expect(dto!.status).toBe('APPROVED');
    const approvals = await query.approvals(id, pmActor);
    expect(approvals).toHaveLength(1);
    expect(approvals![0].decision).toBe('APPROVED');

    // No ledger, no stock: only the requisition tables changed; no journal_entry/stock_movement written by REQ.
    const je = await ds.query(`SELECT COUNT(*)::int AS n FROM journal_entry`);
    expect(je[0].n).toBe(0);
    const sm = await ds.query(`SELECT COUNT(*)::int AS n FROM stock_movement WHERE source_type <> 'Seed'`);
    expect(sm[0].n).toBe(0);
  });

  it('AC3 — an escalated (ACCOUNTS-tier) requisition cannot be PM-approved; ACCOUNTS approves it', async () => {
    const { id } = await createReq.execute(baseCreate({ lines: [line('300')] }), pmActor); // 156,000 > 100,000 → ACCOUNTS
    await submitReq.execute(id, pmActor);
    expect((await query.get(id, accountsActor))!.approvalTier).toBe('ACCOUNTS');

    await expect(approveReq.execute(id, null, pmActor)).rejects.toBeInstanceOf(ApprovalBeyondAuthorityError);
    expect((await query.get(id, accountsActor))!.status).toBe('SUBMITTED');

    await approveReq.execute(id, null, accountsActor);
    expect((await query.get(id, accountsActor))!.status).toBe('APPROVED');
  });

  it('AC — reject requires a reason; a reason moves to REJECTED', async () => {
    const { id } = await createReq.execute(baseCreate(), pmActor);
    await submitReq.execute(id, pmActor);
    await expect(rejectReq.execute(id, '   ', pmActor)).rejects.toBeInstanceOf(MissingRejectReasonError);
    await rejectReq.execute(id, 'over budget', pmActor);
    expect((await query.get(id, accountsActor))!.status).toBe('REJECTED');
  });

  it('AC — manual close abandons the balance → CLOSED (no ledger effect)', async () => {
    const { id } = await createReq.execute(baseCreate(), pmActor);
    await submitReq.execute(id, pmActor);
    await approveReq.execute(id, null, pmActor);
    await closeReq.execute(id, 'client cancelled', pmActor);
    const dto = await query.get(id, accountsActor);
    expect(dto!.status).toBe('CLOSED');
    expect(dto!.closedReason).toBe('client cancelled');
    const je = await ds.query(`SELECT COUNT(*)::int AS n FROM journal_entry`);
    expect(je[0].n).toBe(0);
  });

  it('AC — the balance-invariant CHECK fires on a forced bad write', async () => {
    const { id } = await createReq.execute(baseCreate(), pmActor);
    const lineRow = await ds.query(`SELECT id FROM requisition_line WHERE requisition_id = $1`, [id]);
    await expect(
      // issued 10 + balance 80 ≠ requested 80 → chk_requisition_line_balance_invariant
      ds.query(`UPDATE requisition_line SET issued_quantity = 10 WHERE id = $1`, [lineRow[0].id]),
    ).rejects.toThrow(/chk_requisition_line_balance_invariant/);
  });

  it('AC — hasOutstanding=true lists only requisitions with a positive line balance', async () => {
    const { id } = await createReq.execute(baseCreate(), pmActor);
    await submitReq.execute(id, pmActor);
    await approveReq.execute(id, null, pmActor);
    const page = await query.list({ hasOutstanding: true }, pmActor);
    expect(page.items.map((r) => r.id)).toContain(id);
  });

  it('AC — a PM cannot read another project’s requisition (403)', async () => {
    const { id } = await createReq.execute(baseCreate(), pmActor);
    await expect(query.get(id, pmOther)).rejects.toThrow();
    // ... and it is excluded from pmOther's list.
    const page = await query.list({}, pmOther);
    expect(page.items.map((r) => r.id)).not.toContain(id);
  });
});
