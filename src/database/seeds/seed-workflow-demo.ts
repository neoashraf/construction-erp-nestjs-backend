/**
 * Requisition → Purchase → Inventory workflow demo seed.
 *
 * Seeds the master/prerequisite data those three modules read via FK but do not own themselves,
 * so a tester can drive the real flow through the API without hitting FK/scope errors:
 *   - 12 monthly OPEN `accounting_period` rows for FY 2025-26 (PostingService.assertOpen needs one —
 *     `seed.ts` never creates these, so posting a Purchase Bill fails with NoPeriodDefinedError today).
 *   - one demo Project (+ customer & PM already resolved), Cost Centre, Godown, Purpose.
 *   - one supplier Party and two Items (default_account_id → CoA "1300 Inventory").
 *   - `user_project` scope rows for the PM / Site Engineer / Store Keeper seed users, required by
 *     AccessPolicy.assertProjectInScope on requisition create and GRN create.
 *
 * Does NOT create the Requisition / PO / Bill / GRN documents themselves — those go through the real
 * use cases (numbering, weighted-average valuation, tag-matrix, journal balancing all live there) so
 * you should create them via the API. This script prints ready-to-use request bodies at the end.
 *
 * Prerequisite: `npm run seed` must have already run (company, FY 2025-26, Chart of Accounts, users).
 *
 * Usage:
 *   npm run seed              # first, if not already done
 *   npm run seed:workflow-demo
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../data-source';
import { monthlyPeriods } from '../../core/period/domain/period-generation';

dotenv.config();

// ── Configuration ─────────────────────────────────────────────────────────────

const COMPANY_NAME = 'Zakir Enterprise'; // must match seed.ts
const FY_LABEL = 'FY 2025-26'; // must match seed.ts
const SEED_PASSWORD = 'ZE@dev2025!'; // must match seed.ts

const INVENTORY_ACCOUNT_CODE = '1300';

const SUPPLIER = { name: 'ABC Building Materials Ltd', phone: '+8801711000001' };
const CUSTOMER = { name: 'Green Valley Developers Ltd', phone: '+8801711000002' };

const PROJECT = {
  code: 'PRJ-DEMO-01',
  name: 'Demo Residential Tower - Bashundhara',
  location: 'Bashundhara R/A, Dhaka',
  startDate: '2025-08-01',
  expectedEndDate: '2027-07-31',
};

const COST_CENTRE = { code: 'CC-CIVIL', name: 'Civil Works' };
const GODOWN_NAME = 'Main Site Store';
const PURPOSE_NAME = 'Site Consumption';

const ITEMS = [
  { code: 'CEMENT-OPC', name: 'OPC Cement 50kg Bag', uom: 'BAG' },
  { code: 'REBAR-12MM', name: 'MS Rebar 12mm', uom: 'KG' },
];

// A voucher date safely inside FY 2025-26 (2025-07-01 → 2026-06-30) so the seeded periods cover it.
const DEMO_VOUCHER_DATE = '2026-05-15';

const PROJECT_USER_EMAILS = ['pm@ze.local', 'engineer@ze.local', 'storekeeper@ze.local'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(`  ${msg}\n`);
}

function banner(msg: string): void {
  process.stdout.write(`\n${'═'.repeat(70)}\n  ${msg}\n${'═'.repeat(70)}\n`);
}

function toDateStr(v: unknown): string {
  // pg parses `date` columns to a JS Date at local midnight — read local getters (not
  // toISOString/UTC getters), otherwise a positive UTC offset (e.g. Asia/Dhaka, +6) rolls
  // the calendar date back by one day.
  if (!(v instanceof Date)) return String(v);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

async function mustGet<T = { id: string }>(
  ds: DataSource,
  sql: string,
  params: unknown[],
  errMsg: string,
): Promise<T> {
  const rows = await ds.query(sql, params);
  if (rows.length === 0) throw new Error(errMsg);
  return rows[0];
}

// ── Ensure functions (idempotent — check natural key, insert if missing) ──────

async function ensureAccountingPeriods(
  ds: DataSource,
  companyId: string,
  financialYearId: string,
  fyStart: string,
  fyEnd: string,
): Promise<void> {
  const existing = await ds.query(
    `SELECT name FROM "accounting_period" WHERE company_id = $1 AND financial_year_id = $2`,
    [companyId, financialYearId],
  );
  const existingNames = new Set<string>(existing.map((r: { name: string }) => r.name));

  let inserted = 0;
  for (const span of monthlyPeriods(fyStart, fyEnd)) {
    if (existingNames.has(span.name)) continue;
    await ds.query(
      `INSERT INTO "accounting_period"
         (id, company_id, financial_year_id, name, start_date, end_date, status, version)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', 1)`,
      [crypto.randomUUID(), companyId, financialYearId, span.name, span.startDate, span.endDate],
    );
    inserted++;
  }
  log(inserted > 0 ? `Accounting periods      → ${inserted} OPEN month(s) created` : 'Accounting periods      → already seeded');
}

async function ensureParty(
  ds: DataSource,
  companyId: string,
  p: { name: string; phone: string; isCustomer: boolean; isSupplier: boolean },
): Promise<string> {
  const rows = await ds.query(`SELECT id FROM "party" WHERE company_id = $1 AND name = $2 LIMIT 1`, [
    companyId,
    p.name,
  ]);
  if (rows.length > 0) {
    log(`Party exists            → ${p.name} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "party" (id, company_id, name, is_customer, is_supplier, phone, is_active, version)
     VALUES ($1, $2, $3, $4, $5, $6, true, 1)`,
    [id, companyId, p.name, p.isCustomer, p.isSupplier, p.phone],
  );
  log(`Party created           → ${p.name} (${id})`);
  return id;
}

async function ensureCostCentre(ds: DataSource, companyId: string): Promise<string> {
  const rows = await ds.query(`SELECT id FROM "cost_centre" WHERE company_id = $1 AND code = $2 LIMIT 1`, [
    companyId,
    COST_CENTRE.code,
  ]);
  if (rows.length > 0) {
    log(`Cost centre exists      → ${COST_CENTRE.code} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "cost_centre" (id, company_id, code, name, is_active, version)
     VALUES ($1, $2, $3, $4, true, 1)`,
    [id, companyId, COST_CENTRE.code, COST_CENTRE.name],
  );
  log(`Cost centre created     → ${COST_CENTRE.code} (${id})`);
  return id;
}

async function ensureProject(
  ds: DataSource,
  companyId: string,
  customerId: string,
  pmUserId: string,
): Promise<string> {
  const rows = await ds.query(
    `SELECT id FROM "project" WHERE company_id = $1 AND project_code = $2 LIMIT 1`,
    [companyId, PROJECT.code],
  );
  if (rows.length > 0) {
    log(`Project exists          → ${PROJECT.code} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "project"
       (id, company_id, project_code, name, location, customer_id, project_manager_id,
        start_date, expected_end_date, status, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PLANNED', 1)`,
    [
      id,
      companyId,
      PROJECT.code,
      PROJECT.name,
      PROJECT.location,
      customerId,
      pmUserId,
      PROJECT.startDate,
      PROJECT.expectedEndDate,
    ],
  );
  log(`Project created         → ${PROJECT.code} (${id})`);
  return id;
}

async function ensureGodown(ds: DataSource, companyId: string, projectId: string): Promise<string> {
  const rows = await ds.query(`SELECT id FROM "godown" WHERE project_id = $1 AND name = $2 LIMIT 1`, [
    projectId,
    GODOWN_NAME,
  ]);
  if (rows.length > 0) {
    log(`Godown exists           → ${GODOWN_NAME} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "godown" (id, company_id, project_id, name, is_active, version)
     VALUES ($1, $2, $3, $4, true, 1)`,
    [id, companyId, projectId, GODOWN_NAME],
  );
  log(`Godown created          → ${GODOWN_NAME} (${id})`);
  return id;
}

async function ensurePurpose(ds: DataSource, companyId: string, projectId: string): Promise<string> {
  const rows = await ds.query(
    `SELECT id FROM "purpose" WHERE project_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [projectId, PURPOSE_NAME],
  );
  if (rows.length > 0) {
    log(`Purpose exists          → ${PURPOSE_NAME} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "purpose" (id, company_id, project_id, name, is_active, version)
     VALUES ($1, $2, $3, $4, true, 1)`,
    [id, companyId, projectId, PURPOSE_NAME],
  );
  log(`Purpose created         → ${PURPOSE_NAME} (${id})`);
  return id;
}

async function ensureItem(
  ds: DataSource,
  companyId: string,
  defaultAccountId: string,
  item: { code: string; name: string; uom: string },
): Promise<string> {
  const rows = await ds.query(`SELECT id FROM "item" WHERE company_id = $1 AND code = $2 LIMIT 1`, [
    companyId,
    item.code,
  ]);
  if (rows.length > 0) {
    log(`Item exists             → ${item.code} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "item" (id, company_id, code, name, base_uom, default_account_id, is_active, version)
     VALUES ($1, $2, $3, $4, $5, $6, true, 1)`,
    [id, companyId, item.code, item.name, item.uom, defaultAccountId],
  );
  log(`Item created            → ${item.code} (${id})`);
  return id;
}

async function ensureUserProject(
  ds: DataSource,
  companyId: string,
  userId: string,
  projectId: string,
): Promise<void> {
  const rows = await ds.query(
    `SELECT id FROM "user_project" WHERE user_id = $1 AND project_id = $2 LIMIT 1`,
    [userId, projectId],
  );
  if (rows.length > 0) return;
  await ds.query(
    `INSERT INTO "user_project" (id, user_id, project_id, company_id) VALUES ($1, $2, $3, $4)`,
    [crypto.randomUUID(), userId, projectId, companyId],
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner('ZE-ERP — Requisition → Purchase → Inventory workflow demo seed');

  const ds = new DataSource(
    buildDataSourceOptions({
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'ze_erp',
      ssl: process.env.DB_SSL === 'true',
      poolMax: 5,
    }),
  );

  await ds.initialize();
  log('Database connected');

  const company = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "company" WHERE name = $1 LIMIT 1`,
    [COMPANY_NAME],
    `Company "${COMPANY_NAME}" not found. Run "npm run seed" first.`,
  );
  const companyId = company.id;

  const fy = await mustGet<{ id: string; start_date: string; end_date: string }>(
    ds,
    `SELECT id, start_date, end_date FROM "financial_year" WHERE company_id = $1 AND label = $2 LIMIT 1`,
    [companyId, FY_LABEL],
    `Financial year "${FY_LABEL}" not found. Run "npm run seed" first.`,
  );

  const invAccount = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "account" WHERE company_id = $1 AND code = $2 LIMIT 1`,
    [companyId, INVENTORY_ACCOUNT_CODE],
    `Account "${INVENTORY_ACCOUNT_CODE}" (Inventory) not found. Run "npm run seed" first (Chart of Accounts).`,
  );

  const userIds: Record<string, string> = {};
  for (const email of PROJECT_USER_EMAILS) {
    const u = await mustGet<{ id: string }>(
      ds,
      `SELECT id FROM "user" WHERE company_id = $1 AND email = $2 LIMIT 1`,
      [companyId, email],
      `User "${email}" not found. Run "npm run seed" first.`,
    );
    userIds[email] = u.id;
  }

  await ensureAccountingPeriods(ds, companyId, fy.id, toDateStr(fy.start_date), toDateStr(fy.end_date));

  const supplierId = await ensureParty(ds, companyId, {
    ...SUPPLIER,
    isCustomer: false,
    isSupplier: true,
  });
  const customerId = await ensureParty(ds, companyId, {
    ...CUSTOMER,
    isCustomer: true,
    isSupplier: false,
  });

  const costCentreId = await ensureCostCentre(ds, companyId);
  const projectId = await ensureProject(ds, companyId, customerId, userIds['pm@ze.local']);
  const godownId = await ensureGodown(ds, companyId, projectId);
  const purposeId = await ensurePurpose(ds, companyId, projectId);

  const itemIds: string[] = [];
  for (const item of ITEMS) {
    itemIds.push(await ensureItem(ds, companyId, invAccount.id, item));
  }

  for (const email of PROJECT_USER_EMAILS) {
    await ensureUserProject(ds, companyId, userIds[email], projectId);
  }
  log(`Project scope granted   → ${PROJECT_USER_EMAILS.join(', ')}`);

  await ds.destroy();

  printNextSteps({ projectId, costCentreId, purposeId, godownId, supplierId, itemIds });
}

function printNextSteps(ids: {
  projectId: string;
  costCentreId: string;
  purposeId: string;
  godownId: string;
  supplierId: string;
  itemIds: string[];
}): void {
  banner('Seed complete — drive the workflow through the real API from here');

  log(`Project id     : ${ids.projectId}`);
  log(`Cost centre id : ${ids.costCentreId}`);
  log(`Purpose id     : ${ids.purposeId}`);
  log(`Godown id      : ${ids.godownId}`);
  log(`Supplier id    : ${ids.supplierId}`);
  log(`Item 1 id      : ${ids.itemIds[0]}  (${ITEMS[0].code})`);
  log(`Item 2 id      : ${ids.itemIds[1]}  (${ITEMS[1].code})`);
  log('');
  log(`Login as pm@ze.local / engineer@ze.local / storekeeper@ze.local, password: ${SEED_PASSWORD}`);
  log(`Use voucher/receipt dates inside FY 2025-26 (only these periods are OPEN), e.g. ${DEMO_VOUCHER_DATE}.`);
  log('Note: posting the Purchase Bill is what moves stock (receiveIn) — posting the GRN alone does not.');
  log('');

  log('1) POST /api/requisition  (as engineer or pm)');
  log(
    JSON.stringify(
      {
        projectId: ids.projectId,
        costCentreId: ids.costCentreId,
        purposeId: ids.purposeId,
        fromGodownId: ids.godownId,
        requiredDate: DEMO_VOUCHER_DATE,
        priority: 'NORMAL',
        lines: [{ itemId: ids.itemIds[0], requestedQuantity: '100.0000' }],
      },
      null,
      2,
    ),
  );
  log('   then POST /api/requisition/:id/submit and POST /api/requisition/:id/approve');
  log('   (issue happens after the item is in stock — see step 4 below)');
  log('');

  log('2) POST /api/purchase/orders');
  log(
    JSON.stringify(
      {
        projectId: ids.projectId,
        supplierId: ids.supplierId,
        poDate: DEMO_VOUCHER_DATE,
        lines: [
          {
            itemId: ids.itemIds[0],
            orderedQty: '200.0000',
            rate: '520.0000',
            godownId: ids.godownId,
            projectId: ids.projectId,
            costCentreId: ids.costCentreId,
            purposeId: ids.purposeId,
          },
        ],
      },
      null,
      2,
    ),
  );
  log('   then POST /api/purchase/orders/:id/approve');
  log('');

  log('3) POST /api/purchase/bills  (reference the PO id from step 2, or omit it for a direct purchase)');
  log(
    JSON.stringify(
      {
        projectId: ids.projectId,
        supplierId: ids.supplierId,
        purchaseOrderId: '<po-id-from-step-2>',
        billDate: DEMO_VOUCHER_DATE,
        dueDate: DEMO_VOUCHER_DATE,
        lines: [
          {
            itemId: ids.itemIds[0],
            isStockLine: true,
            billedQty: '200.0000',
            rate: '520.0000',
            godownId: ids.godownId,
            projectId: ids.projectId,
            costCentreId: ids.costCentreId,
            purposeId: ids.purposeId,
          },
        ],
      },
      null,
      2,
    ),
  );
  log('   then POST /api/purchase/bills/:id/post  — THIS is what rolls stock_balance/stock_movement');
  log('');

  log('4) POST /api/purchase/grns  (informational receipt record, no ledger/stock side effect)');
  log(
    JSON.stringify(
      {
        projectId: ids.projectId,
        supplierId: ids.supplierId,
        purchaseBillId: '<bill-id-from-step-3>',
        receiptDate: DEMO_VOUCHER_DATE,
      },
      null,
      2,
    ),
  );
  log('   then POST /api/purchase/grns/:id/post');
  log('');

  log('5) Back to Requisition: POST /api/requisition/:id/issue  (as storekeeper, from the same godown)');
  log(
    JSON.stringify(
      {
        fromGodownId: ids.godownId,
        lines: [{ requisitionLineId: '<requisition-line-id-from-step-1>', issueQuantity: '50.0000' }],
      },
      null,
      2,
    ),
  );
  log('   this is what finally debits Material Expense / credits Inventory and drops stock_balance');
  log('');

  banner('Done');
}

main().catch((err: unknown) => {
  process.stderr.write(`\nSeed failed: ${String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
