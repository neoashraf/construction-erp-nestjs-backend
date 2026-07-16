/**
 * Sales/IPC · Purchase · Inventory · Requisition · HR-Payroll · Receipt · Payment · Contra/Journal
 * sample-data seed.
 *
 * Covers every business module under `src/modules/` that is actually implemented and wired into
 * `app.module.ts` (verified by reading each controller) — not the ones that only exist as SRS/API-
 * contract docs.
 *
 * Mirrors `seed-workflow-demo.ts`'s philosophy: voucher-bearing records (IPC, PO/Bill/GRN, Stock
 * Journal, Requisition, Attendance/Salary, Receipt, Payment, Contra, Journal) are NOT inserted
 * directly by raw SQL here — numbering, weighted-average valuation, the tag matrix, and journal
 * balancing all live in each module's use cases, and the only ledger writer is LED's `PostingService`
 * (CLAUDE.md "one posting layer"). Instead this script:
 *   1. Seeds the small amount of ADDITIONAL master data these modules need that
 *      `seed-workflow-demo.ts` does not already provide — a second godown (for a stock TRANSFER demo),
 *      a "Labour" cost centre + a "Client Billing" purpose, `hr_account_config` role→account mappings
 *      (documented in the entity as "seeded at go-live" — not covered by any existing seed), project
 *      scope for the HR user, and 3 office-staff Employees (pure master data — safe to insert directly,
 *      same as the existing Party/Item ensure helpers).
 *   2. Prints 2-3 ready-to-use request bodies per module so a developer/tester can drive them through
 *      the real API (create → submit/approve → post), the same as `seed-workflow-demo.ts` step 5.
 *
 * Prerequisite: `npm run seed` AND `npm run seed:workflow-demo` must have already run (company, FY,
 * CoA, users, project, cost centre, godown, purpose, supplier/customer, items).
 *
 * Usage:
 *   npm run seed:module-samples
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../data-source';

dotenv.config();

// ── Configuration ─────────────────────────────────────────────────────────────

const COMPANY_NAME = 'Zakir Enterprise'; // must match seed.ts
const PROJECT_CODE = 'PRJ-DEMO-01'; // must match seed-workflow-demo.ts
const COST_CENTRE_CODE = 'CC-CIVIL'; // must match seed-workflow-demo.ts
const GODOWN_NAME = 'Main Site Store'; // must match seed-workflow-demo.ts
const PURPOSE_NAME = 'Site Consumption'; // must match seed-workflow-demo.ts
const SUPPLIER_NAME = 'ABC Building Materials Ltd'; // must match seed-workflow-demo.ts
const CUSTOMER_NAME = 'Green Valley Developers Ltd'; // must match seed-workflow-demo.ts
const ITEM_CODES = ['CEMENT-OPC', 'REBAR-12MM']; // must match seed-workflow-demo.ts

const LABOUR_COST_CENTRE = { code: 'CC-LABOUR', name: 'Labour' };
const CENTRAL_GODOWN_NAME = 'Central Warehouse';
const BILLING_PURPOSE_NAME = 'Client Billing';

// hr_account_config role → CoA code. Phase-1 CoA (construction-coa.seed.ts) has no dedicated
// employer-PF-expense or PF-payable account, so EMPLOYER_PF/PF_PAYABLE/STAFF_ADVANCE_RECOVERY
// pragmatically reuse the nearest existing account for this dev seed — a real go-live config
// would add and map dedicated accounts.
const HR_ACCOUNT_CONFIG: Record<string, string> = {
  GROSS_SALARY: '6100', // Salary Expense
  EMPLOYER_PF: '6100', // Salary Expense (reused — no dedicated employer-PF-expense account yet)
  SALARY_PAYABLE: '2300', // Salary Payable
  TDS_PAYABLE: '2210', // TDS Payable
  PF_PAYABLE: '2210', // TDS Payable (reused — no dedicated PF-payable account yet)
  STAFF_ADVANCE_RECOVERY: '2300', // Salary Payable (reused — no dedicated staff-advance account yet)
};

const EMPLOYEES = [
  {
    code: 'EMP-001',
    name: 'Md. Karim Hossain',
    designation: 'Site Engineer',
    department: 'Engineering',
    workBase: 'SITE',
    wageType: 'MONTHLY',
    wageAmount: '55000.0000',
    pfApplicable: true,
    gratuityApplicable: true,
    wppfApplicable: false,
    joiningDate: '2024-01-15',
  },
  {
    code: 'EMP-002',
    name: 'Fatema Begum',
    designation: 'Site Accountant',
    department: 'Accounts',
    workBase: 'SITE',
    wageType: 'MONTHLY',
    wageAmount: '45000.0000',
    pfApplicable: true,
    gratuityApplicable: true,
    wppfApplicable: false,
    joiningDate: '2024-03-01',
  },
  {
    code: 'EMP-003',
    name: 'Abdul Kader',
    designation: 'Store Keeper',
    department: 'Store',
    workBase: 'SITE',
    wageType: 'MONTHLY',
    wageAmount: '32000.0000',
    pfApplicable: false,
    gratuityApplicable: false,
    wppfApplicable: false,
    joiningDate: '2025-02-10',
  },
];

const DEMO_DATE_1 = '2026-06-05';
const DEMO_DATE_2 = '2026-06-20';

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(`  ${msg}\n`);
}

function banner(msg: string): void {
  process.stdout.write(`\n${'═'.repeat(74)}\n  ${msg}\n${'═'.repeat(74)}\n`);
}

function section(msg: string): void {
  process.stdout.write(`\n  ── ${msg} ${'─'.repeat(Math.max(0, 66 - msg.length))}\n`);
}

function payload(method: string, path: string, body?: unknown): void {
  log(`${method} ${path}`);
  if (body !== undefined) log(JSON.stringify(body, null, 2).split('\n').join('\n  '));
  log('');
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

async function ensureCostCentre(
  ds: DataSource,
  companyId: string,
  cc: { code: string; name: string },
): Promise<string> {
  const rows = await ds.query(`SELECT id FROM "cost_centre" WHERE company_id = $1 AND code = $2 LIMIT 1`, [
    companyId,
    cc.code,
  ]);
  if (rows.length > 0) {
    log(`Cost centre exists      → ${cc.code} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "cost_centre" (id, company_id, code, name, is_active, version)
     VALUES ($1, $2, $3, $4, true, 1)`,
    [id, companyId, cc.code, cc.name],
  );
  log(`Cost centre created     → ${cc.code} (${id})`);
  return id;
}

async function ensureGodown(ds: DataSource, companyId: string, projectId: string, name: string): Promise<string> {
  const rows = await ds.query(`SELECT id FROM "godown" WHERE project_id = $1 AND name = $2 LIMIT 1`, [
    projectId,
    name,
  ]);
  if (rows.length > 0) {
    log(`Godown exists           → ${name} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "godown" (id, company_id, project_id, name, is_active, version)
     VALUES ($1, $2, $3, $4, true, 1)`,
    [id, companyId, projectId, name],
  );
  log(`Godown created          → ${name} (${id})`);
  return id;
}

async function ensurePurpose(ds: DataSource, companyId: string, projectId: string, name: string): Promise<string> {
  const rows = await ds.query(
    `SELECT id FROM "purpose" WHERE project_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [projectId, name],
  );
  if (rows.length > 0) {
    log(`Purpose exists          → ${name} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "purpose" (id, company_id, project_id, name, is_active, version)
     VALUES ($1, $2, $3, $4, true, 1)`,
    [id, companyId, projectId, name],
  );
  log(`Purpose created         → ${name} (${id})`);
  return id;
}

async function ensureUserProject(ds: DataSource, companyId: string, userId: string, projectId: string): Promise<void> {
  const rows = await ds.query(`SELECT id FROM "user_project" WHERE user_id = $1 AND project_id = $2 LIMIT 1`, [
    userId,
    projectId,
  ]);
  if (rows.length > 0) return;
  await ds.query(`INSERT INTO "user_project" (id, user_id, project_id, company_id) VALUES ($1, $2, $3, $4)`, [
    crypto.randomUUID(),
    userId,
    projectId,
    companyId,
  ]);
  log(`Project scope granted   → hr@ze.local`);
}

async function ensureHrAccountConfig(
  ds: DataSource,
  companyId: string,
  accountIdByCode: Map<string, string>,
  labourCostCentreId: string,
): Promise<void> {
  const existing = await ds.query(`SELECT role FROM "hr_account_config" WHERE company_id = $1`, [companyId]);
  const existingRoles = new Set<string>(existing.map((r: { role: string }) => r.role));

  let inserted = 0;
  for (const [role, code] of Object.entries(HR_ACCOUNT_CONFIG)) {
    if (existingRoles.has(role)) continue;
    const accountId = accountIdByCode.get(code);
    if (!accountId) throw new Error(`hr_account_config: account code ${code} not found for role ${role}`);
    await ds.query(
      `INSERT INTO "hr_account_config" (id, company_id, role, account_id, cost_centre_id)
       VALUES ($1, $2, $3, $4, NULL)`,
      [crypto.randomUUID(), companyId, role, accountId],
    );
    inserted++;
  }
  if (!existingRoles.has('LABOUR_COST_CENTRE')) {
    await ds.query(
      `INSERT INTO "hr_account_config" (id, company_id, role, account_id, cost_centre_id)
       VALUES ($1, $2, 'LABOUR_COST_CENTRE', NULL, $3)`,
      [crypto.randomUUID(), companyId, labourCostCentreId],
    );
    inserted++;
  }
  log(inserted > 0 ? `HR account config       → ${inserted} role(s) mapped` : 'HR account config       → already seeded');
}

async function ensureEmployee(
  ds: DataSource,
  companyId: string,
  defaultProjectId: string,
  e: (typeof EMPLOYEES)[number],
): Promise<string> {
  const rows = await ds.query(`SELECT id FROM "employee" WHERE company_id = $1 AND employee_code = $2 LIMIT 1`, [
    companyId,
    e.code,
  ]);
  if (rows.length > 0) {
    log(`Employee exists         → ${e.code} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "employee"
       (id, company_id, employee_code, name, designation, default_project_id, department, work_base,
        wage_type, wage_amount, pf_applicable, gratuity_applicable, wppf_applicable, joining_date,
        status, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'ACTIVE', 1)`,
    [
      id,
      companyId,
      e.code,
      e.name,
      e.designation,
      defaultProjectId,
      e.department,
      e.workBase,
      e.wageType,
      e.wageAmount,
      e.pfApplicable,
      e.gratuityApplicable,
      e.wppfApplicable,
      e.joiningDate,
    ],
  );
  log(`Employee created        → ${e.code} — ${e.name} (${id})`);
  return id;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner('ZE-ERP — Sales/IPC · Purchase · Inventory · Requisition · HR-Payroll sample-data seed');

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

  const project = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "project" WHERE company_id = $1 AND project_code = $2 LIMIT 1`,
    [companyId, PROJECT_CODE],
    `Project "${PROJECT_CODE}" not found. Run "npm run seed:workflow-demo" first.`,
  );
  const projectId = project.id;

  const civilCC = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "cost_centre" WHERE company_id = $1 AND code = $2 LIMIT 1`,
    [companyId, COST_CENTRE_CODE],
    `Cost centre "${COST_CENTRE_CODE}" not found. Run "npm run seed:workflow-demo" first.`,
  );

  const mainGodown = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "godown" WHERE project_id = $1 AND name = $2 LIMIT 1`,
    [projectId, GODOWN_NAME],
    `Godown "${GODOWN_NAME}" not found. Run "npm run seed:workflow-demo" first.`,
  );

  const consumptionPurpose = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "purpose" WHERE project_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [projectId, PURPOSE_NAME],
    `Purpose "${PURPOSE_NAME}" not found. Run "npm run seed:workflow-demo" first.`,
  );

  const supplier = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "party" WHERE company_id = $1 AND name = $2 LIMIT 1`,
    [companyId, SUPPLIER_NAME],
    `Supplier "${SUPPLIER_NAME}" not found. Run "npm run seed:workflow-demo" first.`,
  );

  const customer = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "party" WHERE company_id = $1 AND name = $2 LIMIT 1`,
    [companyId, CUSTOMER_NAME],
    `Customer "${CUSTOMER_NAME}" not found. Run "npm run seed:workflow-demo" first.`,
  );

  const itemIds: Record<string, string> = {};
  for (const code of ITEM_CODES) {
    const item = await mustGet<{ id: string }>(
      ds,
      `SELECT id FROM "item" WHERE company_id = $1 AND code = $2 LIMIT 1`,
      [companyId, code],
      `Item "${code}" not found. Run "npm run seed:workflow-demo" first.`,
    );
    itemIds[code] = item.id;
  }

  const hrUser = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "user" WHERE company_id = $1 AND email = $2 LIMIT 1`,
    [companyId, 'hr@ze.local'],
    `User "hr@ze.local" not found. Run "npm run seed" first.`,
  );

  section('Additional master data');

  const labourCC = await ensureCostCentre(ds, companyId, LABOUR_COST_CENTRE);
  const centralGodown = await ensureGodown(ds, companyId, projectId, CENTRAL_GODOWN_NAME);
  const billingPurpose = await ensurePurpose(ds, companyId, projectId, BILLING_PURPOSE_NAME);
  await ensureUserProject(ds, companyId, hrUser.id, projectId);

  const accountRows = await ds.query(`SELECT id, code FROM "account" WHERE company_id = $1`, [companyId]);
  const accountIdByCode = new Map<string, string>(accountRows.map((r: { id: string; code: string }) => [r.code, r.id]));
  await ensureHrAccountConfig(ds, companyId, accountIdByCode, labourCC);

  const mustAccount = (code: string): string => {
    const id = accountIdByCode.get(code);
    if (!id) throw new Error(`Account code ${code} not found — run "npm run seed" first (Chart of Accounts).`);
    return id;
  };
  const bankAccountId = mustAccount('1110'); // Bank Account
  const cashAccountId = mustAccount('1100'); // Cash in Hand
  const mobilizationAdvanceAccountId = mustAccount('2110'); // Mobilization Advance
  const overheadsAccountId = mustAccount('6300'); // General Overheads

  const employeeIds: string[] = [];
  for (const e of EMPLOYEES) {
    employeeIds.push(await ensureEmployee(ds, companyId, projectId, e));
  }

  await ds.destroy();

  printSamples({
    projectId,
    costCentreId: civilCC.id,
    labourCostCentreId: labourCC,
    purposeId: consumptionPurpose.id,
    billingPurposeId: billingPurpose,
    godownId: mainGodown.id,
    centralGodownId: centralGodown,
    supplierId: supplier.id,
    customerId: customer.id,
    cementId: itemIds['CEMENT-OPC'],
    rebarId: itemIds['REBAR-12MM'],
    employeeIds,
    bankAccountId,
    cashAccountId,
    mobilizationAdvanceAccountId,
    overheadsAccountId,
  });
}

interface Ids {
  projectId: string;
  costCentreId: string;
  labourCostCentreId: string;
  purposeId: string;
  billingPurposeId: string;
  godownId: string;
  centralGodownId: string;
  supplierId: string;
  customerId: string;
  cementId: string;
  rebarId: string;
  employeeIds: string[];
  bankAccountId: string;
  cashAccountId: string;
  mobilizationAdvanceAccountId: string;
  overheadsAccountId: string;
}

function printSamples(ids: Ids): void {
  banner('Master data ready — POST these through the real API (they will draft → post via each');
  log('module\'s own use case, so numbering / valuation / the ledger stay correct per CLAUDE.md).');
  log(`Login as pm@ze.local / engineer@ze.local / storekeeper@ze.local / hr@ze.local / accounts@ze.local,`);
  log(`password: ZE@dev2025!  Use dates inside FY 2025-26, e.g. ${DEMO_DATE_1} / ${DEMO_DATE_2}.`);

  // ── 1) Sales / IPC ───────────────────────────────────────────────────────
  section('1) Sales / IPC — 2 draft IPCs (POST /api/sales/ipc, then …/{id}/post)');
  payload('POST', '/api/sales/ipc', {
    projectId: ids.projectId,
    ipcSeqNo: 1,
    ipcDate: DEMO_DATE_1,
    billDate: DEMO_DATE_1,
    dueDate: '2026-07-05',
    workCompletedPct: '20.0000',
    certifiedAmount: '2000000.0000',
    costCentreId: ids.costCentreId,
    purposeId: ids.billingPurposeId,
    narration: 'IPC #1 — Foundation & Plinth',
  });
  payload('POST', '/api/sales/ipc', {
    projectId: ids.projectId,
    ipcSeqNo: 2,
    ipcDate: DEMO_DATE_2,
    billDate: DEMO_DATE_2,
    dueDate: '2026-07-20',
    workCompletedPct: '35.0000',
    certifiedAmount: '1500000.0000',
    costCentreId: ids.costCentreId,
    purposeId: ids.billingPurposeId,
    narration: 'IPC #2 — Column & Beam',
  });
  log('(retentionAmount/advanceRecoveredAmount/outputVatAmount default from configured rates — 10%/15%/15%)');

  // ── 2) Purchase — PO, Bill, GRN ─────────────────────────────────────────
  section('2) Purchase — 2 Purchase Orders (POST /api/purchase/orders, then …/{id}/approve)');
  payload('POST', '/api/purchase/orders', {
    projectId: ids.projectId,
    supplierId: ids.supplierId,
    poDate: DEMO_DATE_1,
    lines: [
      {
        itemId: ids.cementId,
        orderedQty: '300.0000',
        rate: '520.0000',
        godownId: ids.godownId,
        costCentreId: ids.costCentreId,
        purposeId: ids.purposeId,
      },
    ],
  });
  payload('POST', '/api/purchase/orders', {
    projectId: ids.projectId,
    supplierId: ids.supplierId,
    poDate: DEMO_DATE_2,
    lines: [
      {
        itemId: ids.rebarId,
        orderedQty: '500.0000',
        rate: '95.0000',
        godownId: ids.godownId,
        costCentreId: ids.costCentreId,
        purposeId: ids.purposeId,
      },
    ],
  });
  log('Then a Bill against each approved PO (POST /api/purchase/bills, then …/{id}/post — this is');
  log('what rolls stock via INV.receiveIn), and optionally a GRN (POST /api/purchase/grns) for a');
  log('decoupled/partial receipt:');
  payload('POST', '/api/purchase/bills', {
    projectId: ids.projectId,
    supplierId: ids.supplierId,
    purchaseOrderId: '<po-1-id>',
    supplierInvoiceRef: 'ABC-INV-1001',
    billDate: DEMO_DATE_1,
    dueDate: '2026-07-05',
    lines: [
      {
        itemId: ids.cementId,
        isStockLine: true,
        billedQty: '300.0000',
        rate: '520.0000',
        godownId: ids.godownId,
        costCentreId: ids.costCentreId,
        purposeId: ids.purposeId,
      },
    ],
  });

  // ── 3) Inventory — Stock Journal ────────────────────────────────────────
  section('3) Inventory — 2 Stock Journals (POST /api/stock-journal, then …/{id}/approve, …/{id}/post)');
  log('(requires stock already in "Main Site Store" from a posted purchase bill above)');
  payload('POST', '/api/stock-journal', {
    voucherDate: DEMO_DATE_2,
    mode: 'ISSUE',
    fromGodownId: ids.godownId,
    itemId: ids.cementId,
    quantity: '20.0000',
    projectId: ids.projectId,
    costCentreId: ids.costCentreId,
    purposeId: ids.purposeId,
    narration: 'Issued for column casting',
  });
  payload('POST', '/api/stock-journal', {
    voucherDate: DEMO_DATE_2,
    mode: 'TRANSFER',
    fromGodownId: ids.godownId,
    toGodownId: ids.centralGodownId,
    itemId: ids.rebarId,
    quantity: '50.0000',
    projectId: ids.projectId,
    costCentreId: ids.costCentreId,
    purposeId: ids.purposeId,
    narration: 'Rebar moved to central warehouse for cutting',
  });

  // ── 4) Requisition ───────────────────────────────────────────────────────
  section('4) Requisition — 3 material requisitions (POST /api/requisition, then …/submit, …/approve)');
  payload('POST', '/api/requisition', {
    projectId: ids.projectId,
    costCentreId: ids.costCentreId,
    purposeId: ids.purposeId,
    fromGodownId: ids.godownId,
    requiredDate: DEMO_DATE_2,
    priority: 'NORMAL',
    narration: 'Cement for slab pour',
    lines: [{ itemId: ids.cementId, requestedQuantity: '100.0000' }],
  });
  payload('POST', '/api/requisition', {
    projectId: ids.projectId,
    costCentreId: ids.costCentreId,
    purposeId: ids.purposeId,
    fromGodownId: ids.godownId,
    requiredDate: DEMO_DATE_2,
    priority: 'HIGH',
    narration: 'Rebar for column casting',
    lines: [{ itemId: ids.rebarId, requestedQuantity: '200.0000' }],
  });
  payload('POST', '/api/requisition', {
    projectId: ids.projectId,
    costCentreId: ids.costCentreId,
    purposeId: ids.purposeId,
    fromGodownId: ids.godownId,
    requiredDate: DEMO_DATE_1,
    priority: 'URGENT',
    narration: 'Emergency top-up — cement short on site',
    lines: [{ itemId: ids.cementId, requestedQuantity: '30.0000' }],
  });

  // ── 5) HR / Attendance / Payroll ────────────────────────────────────────
  section('5) HR — 3 Employees already seeded:');
  for (const [i, id] of ids.employeeIds.entries()) log(`  ${EMPLOYEES[i].code} — ${EMPLOYEES[i].name}  (${id})`);
  log('');
  log('Office attendance (POST /api/attendance/office):');
  payload('POST', '/api/attendance/office', {
    rows: [
      { employeeId: ids.employeeIds[0], attendanceDate: DEMO_DATE_1, projectId: ids.projectId, dayStatus: 'PRESENT' },
      { employeeId: ids.employeeIds[1], attendanceDate: DEMO_DATE_1, projectId: ids.projectId, dayStatus: 'PRESENT' },
      { employeeId: ids.employeeIds[2], attendanceDate: DEMO_DATE_1, projectId: ids.projectId, dayStatus: 'PAID_LEAVE' },
    ],
  });
  log('Daily-labour head count (POST /api/attendance/daily-labour, then …/{id}/confirm to accrue):');
  payload('POST', '/api/attendance/daily-labour', {
    rows: [
      {
        attendanceDate: DEMO_DATE_1,
        projectId: ids.projectId,
        costCentreId: ids.labourCostCentreId,
        purposeId: ids.purposeId,
        labourCategory: 'Mason',
        headCount: 20,
        dailyRate: '650.0000',
      },
      {
        attendanceDate: DEMO_DATE_2,
        projectId: ids.projectId,
        costCentreId: ids.labourCostCentreId,
        purposeId: ids.purposeId,
        labourCategory: 'Rod Binder',
        headCount: 12,
        dailyRate: '700.0000',
      },
    ],
  });
  log('Salary sheet (POST /api/salary/sheets/generate, then …/{id}/post):');
  payload('POST', '/api/salary/sheets/generate', {
    financialYearId: '<fy-id>',
    periodLabel: '2026-06',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    projectId: ids.projectId,
  });

  // ── 6) Receipt ────────────────────────────────────────────────────────────
  section('6) Receipt — 2 receipts (POST /api/receipt, then …/{id}/post)');
  log('IPC-linked — part collection against IPC #1 from section 1 above:');
  payload('POST', '/api/receipt', {
    receiptType: 'IPC_LINKED',
    receiptDate: DEMO_DATE_2,
    paymentMode: 'BANK_TRANSFER',
    depositAccountId: ids.bankAccountId,
    ipcId: '<ipc-1-id>',
    projectId: ids.projectId,
    costCentreId: ids.costCentreId,
    purposeId: ids.billingPurposeId,
    amountSettled: '500000.0000',
    taxDeductedAtSource: '0.0000',
    chequeTxnRef: 'TXN-2026-0099',
    narration: 'IPC #1 part collection',
  });
  log('General — mobilization advance received from the customer (not tied to a specific IPC):');
  payload('POST', '/api/receipt', {
    receiptType: 'GENERAL',
    receiptDate: DEMO_DATE_1,
    paymentMode: 'BANK_TRANSFER',
    depositAccountId: ids.bankAccountId,
    partyId: ids.customerId,
    generalTargetAccountId: ids.mobilizationAdvanceAccountId,
    projectId: ids.projectId,
    costCentreId: ids.costCentreId,
    purposeId: ids.billingPurposeId,
    amountSettled: '1000000.0000',
    taxDeductedAtSource: '0.0000',
    narration: 'Mobilization advance — project kickoff',
  });

  // ── 7) Payment ────────────────────────────────────────────────────────────
  section('7) Payment — 2 payments (POST /api/payment, then …/{id}/post)');
  log('Supplier payment — settles the Purchase Bill from section 2 above:');
  payload('POST', '/api/payment', {
    partyId: ids.supplierId,
    paymentDate: DEMO_DATE_2,
    paymentMode: 'BANK_TRANSFER',
    paymentAccountId: ids.bankAccountId,
    chequeTxnRef: 'TXN-2026-0142',
    paymentAmount: '156000.0000',
    narration: 'Part-payment — ABC Building Materials cement bill',
    allocations: [{ payableType: 'PURCHASE_BILL', payableId: '<bill-1-id>', amountAllocated: '156000.0000' }],
  });
  log('Payroll settlement — pays the posted Salary sheet from section 5 above:');
  payload('POST', '/api/payment', {
    paymentDate: '2026-07-05',
    paymentMode: 'BANK_TRANSFER',
    paymentAccountId: ids.bankAccountId,
    paymentAmount: '132000.0000',
    narration: 'June 2026 salary run — bank disbursement',
    allocations: [{ payableType: 'SALARY', payableId: '<salary-sheet-1-id>', amountAllocated: '132000.0000' }],
  });

  // ── 8) Contra / Journal ──────────────────────────────────────────────────
  section('8) Contra & Journal — 2 samples (POST /api/contra or /api/journal, then …/{id}/post)');
  log('Contra — cash withdrawn from bank for site petty cash (bank/cash accounts only, no dimensions):');
  payload('POST', '/api/contra', {
    voucherDate: DEMO_DATE_1,
    narration: 'Cash withdrawal for site petty cash',
    lines: [
      { accountId: ids.bankAccountId, credit: '50000.0000' },
      { accountId: ids.cashAccountId, debit: '50000.0000' },
    ],
  });
  log('Journal — office overheads paid in cash (generic multi-line debit/credit journal):');
  payload('POST', '/api/journal', {
    voucherDate: DEMO_DATE_2,
    narration: 'Site office electricity bill — June 2026',
    lines: [
      {
        accountId: ids.overheadsAccountId,
        projectId: ids.projectId,
        costCentreId: ids.costCentreId,
        purposeId: ids.purposeId,
        debit: '8500.0000',
      },
      { accountId: ids.cashAccountId, credit: '8500.0000' },
    ],
  });

  banner('Done');
}

main().catch((err: unknown) => {
  process.stderr.write(`\nSeed failed: ${String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
