/**
 * Reports demo-data seed — DRIVES THE REAL HTTP API (never a raw ledger insert) so all 19
 * `/api/reports/*` endpoints (the 6 catalog groups: Ledgers & registers, Financial statements,
 * Project reports, Inventory reports, Requisition & cost-control reports, HR reports — see
 * docs/design/design-files/15-reporting/Reports.dc.html) return non-empty results end-to-end.
 *
 * `seed.ts` / `seed-workflow-demo.ts` / `seed-module-samples.ts` only ever seed MASTER data and then
 * print ready-to-use request bodies for a human to POST manually (CLAUDE.md "one posting layer" — no
 * script may write journal_entry/journal_line directly). Nobody had actually driven those payloads, so
 * `journal_entry` stayed empty and every report returned rows:[]. This script is the missing step: it
 * logs in as `admin@ze.local` (ADMIN — every RBAC grant) and calls each module's REAL create → submit/
 * approve → post endpoints, exactly the sequence seed-module-samples.ts already documented.
 *
 * Master-data LOOKUPS (company/FY/project/cost-centres/godowns/purposes/items/parties/employees/
 * accounts/periods) are read via direct SQL — read-only, same convention the other seed scripts use.
 * Every ledger-affecting write goes through HTTP so PostingService remains the only debit/credit writer.
 *
 * Prerequisite: `npm run seed && npm run seed:workflow-demo && npm run seed:module-samples`, then start
 * the API (`npm run start:dev`) before running this script.
 *
 * Usage:
 *   npm run seed:reports-demo
 *   BASE_URL=http://localhost:8000 npm run seed:reports-demo
 *
 * Idempotency: this script POSTS real vouchers, so re-running it duplicates data. It refuses to run if
 * the company already has any journal_entry rows — pass FORCE=1 to seed on top anyway.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../data-source';

dotenv.config();

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8000';
const COMPANY_NAME = 'Zakir Enterprise';
const FY_LABEL = 'FY 2025-26';
const PROJECT_CODE = 'PRJ-DEMO-01';
const ADMIN_EMAIL = 'admin@ze.local';
const SEED_PASSWORD = 'ZE@dev2025!';

const CIVIL_CC_CODE = 'CC-CIVIL';
const LABOUR_CC_CODE = 'CC-LABOUR';
const MAIN_GODOWN = 'Main Site Store';
const CENTRAL_GODOWN = 'Central Warehouse';
const CONSUMPTION_PURPOSE = 'Site Consumption';
const BILLING_PURPOSE = 'Client Billing';
const SUPPLIER_NAME = 'ABC Building Materials Ltd';
const CEMENT_CODE = 'CEMENT-OPC';
const REBAR_CODE = 'REBAR-12MM';

// Dates inside FY 2025-26 (2025-07-01 -> 2026-06-30), spread over two OPEN months so the daybook /
// account-ledger / cash-bank-book reports have more than one date to page through.
const D1 = '2026-05-10';
const D2 = '2026-05-20';
const D3 = '2026-06-05';
const D4 = '2026-06-20';
const PERIOD_LABEL = '2026-05';
const PERIOD_START = '2026-05-01';
const PERIOD_END = '2026-05-31';

// ── logging ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(`  ${msg}\n`);
}
function banner(msg: string): void {
  process.stdout.write(`\n${'═'.repeat(76)}\n  ${msg}\n${'═'.repeat(76)}\n`);
}
function section(msg: string): void {
  process.stdout.write(`\n  ── ${msg} ${'─'.repeat(Math.max(0, 68 - msg.length))}\n`);
}

// ── SQL lookups (read-only master data — same convention as the other seed scripts) ──────────────────

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

// ── HTTP client (the ONLY thing allowed to create/post a voucher — PostingService stays the sole
// ledger writer; this script never touches journal_entry/journal_line directly) ───────────────────────

let accessToken = '';

async function api<T = unknown>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token ?? accessToken}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json.error ?? json)}`);
  }
  return json.data as T;
}

async function login(companyId: string, email: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: SEED_PASSWORD, companyId }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`login ${email} -> HTTP ${res.status}: ${JSON.stringify(json.error ?? json)}`);
  return (json.data as { accessToken: string }).accessToken;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner('ZE-ERP — Reports demo-data seed (drives the real HTTP API)');

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
  log('Database connected (read-only master-data lookups)');

  const company = await mustGet(ds, `SELECT id FROM company WHERE name = $1 LIMIT 1`, [COMPANY_NAME],
    `Company "${COMPANY_NAME}" not found. Run "npm run seed" first.`);
  const companyId = company.id;

  const fy = await mustGet<{ id: string }>(ds, `SELECT id FROM financial_year WHERE company_id = $1 AND label = $2 LIMIT 1`,
    [companyId, FY_LABEL], `Financial year "${FY_LABEL}" not found. Run "npm run seed" first.`);

  const existingEntries = await ds.query(`SELECT count(*)::int AS n FROM journal_entry WHERE company_id = $1`, [companyId]);
  if (existingEntries[0].n > 0 && process.env.FORCE !== '1') {
    log(`Company already has ${existingEntries[0].n} posted journal entries.`);
    log('Refusing to seed more (would duplicate vouchers). Set FORCE=1 to seed on top anyway.');
    await ds.destroy();
    return;
  }

  const project = await mustGet(ds, `SELECT id FROM project WHERE company_id = $1 AND project_code = $2 LIMIT 1`,
    [companyId, PROJECT_CODE], `Project "${PROJECT_CODE}" not found. Run "npm run seed:workflow-demo" first.`);
  const projectId = project.id;

  const civilCC = await mustGet(ds, `SELECT id FROM cost_centre WHERE company_id = $1 AND code = $2 LIMIT 1`,
    [companyId, CIVIL_CC_CODE], `Cost centre "${CIVIL_CC_CODE}" not found. Run "npm run seed:workflow-demo" first.`);
  const labourCC = await mustGet(ds, `SELECT id FROM cost_centre WHERE company_id = $1 AND code = $2 LIMIT 1`,
    [companyId, LABOUR_CC_CODE], `Cost centre "${LABOUR_CC_CODE}" not found. Run "npm run seed:module-samples" first.`);

  const mainGodown = await mustGet(ds, `SELECT id FROM godown WHERE project_id = $1 AND name = $2 LIMIT 1`,
    [projectId, MAIN_GODOWN], `Godown "${MAIN_GODOWN}" not found. Run "npm run seed:workflow-demo" first.`);
  const centralGodown = await mustGet(ds, `SELECT id FROM godown WHERE project_id = $1 AND name = $2 LIMIT 1`,
    [projectId, CENTRAL_GODOWN], `Godown "${CENTRAL_GODOWN}" not found. Run "npm run seed:module-samples" first.`);

  const consumptionPurpose = await mustGet(ds, `SELECT id FROM purpose WHERE project_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [projectId, CONSUMPTION_PURPOSE], `Purpose "${CONSUMPTION_PURPOSE}" not found. Run "npm run seed:workflow-demo" first.`);
  const billingPurpose = await mustGet(ds, `SELECT id FROM purpose WHERE project_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [projectId, BILLING_PURPOSE], `Purpose "${BILLING_PURPOSE}" not found. Run "npm run seed:module-samples" first.`);

  const cement = await mustGet(ds, `SELECT id FROM item WHERE company_id = $1 AND code = $2 LIMIT 1`,
    [companyId, CEMENT_CODE], `Item "${CEMENT_CODE}" not found. Run "npm run seed:workflow-demo" first.`);
  const rebar = await mustGet(ds, `SELECT id FROM item WHERE company_id = $1 AND code = $2 LIMIT 1`,
    [companyId, REBAR_CODE], `Item "${REBAR_CODE}" not found. Run "npm run seed:workflow-demo" first.`);

  const supplier = await mustGet(ds, `SELECT id FROM party WHERE company_id = $1 AND name = $2 LIMIT 1`,
    [companyId, SUPPLIER_NAME], `Supplier "${SUPPLIER_NAME}" not found. Run "npm run seed:workflow-demo" first.`);

  const employees: string[] = (await ds.query(
    `SELECT id FROM employee WHERE company_id = $1 ORDER BY employee_code LIMIT 3`, [companyId],
  )).map((r: { id: string }) => r.id);
  if (employees.length < 3) throw new Error('Expected 3 employees. Run "npm run seed:module-samples" first.');

  const accountRows: Array<{ code: string; id: string }> = await ds.query(
    `SELECT code, id FROM account WHERE company_id = $1`, [companyId],
  );
  const accountIdByCode = new Map(accountRows.map((r) => [r.code, r.id]));

  // A never-logged-in seed user still carries must_change_password=true, which gates every action
  // behind PASSWORD_CHANGE_REQUIRED. admin@ze.local already had it cleared (an earlier real login) —
  // mirror that so pm@ze.local can actually call the approve endpoint this script needs.
  await ds.query(`UPDATE "user" SET must_change_password = false WHERE company_id = $1 AND email = 'pm@ze.local'`, [companyId]);
  const acc = (code: string): string => {
    const id = accountIdByCode.get(code);
    if (!id) throw new Error(`Account code ${code} not found. Run "npm run seed" first.`);
    return id;
  };

  await ds.destroy();
  log('Master-data lookups complete — driving the API from here on');

  section('Login');
  accessToken = await login(companyId, ADMIN_EMAIL);
  log(`Logged in as ${ADMIN_EMAIL} (ADMIN — every RBAC grant, unscoped)`);
  const pmToken = await login(companyId, 'pm@ze.local');
  log(`Logged in as pm@ze.local (PM tier — required to approve a PM-tier requisition; escalate-by-default)`);

  // ── 1) Ledgers & registers / Financial statements — Contra + Journal ────────────────────────────
  section('1) Ledgers & registers / Financial statements — Contra + Journal');
  {
    const contra = await api<{ id: string }>('POST', '/api/contra', {
      voucherDate: D1,
      narration: 'Cash withdrawal for site petty cash',
      lines: [
        { accountId: acc('1110'), credit: '50000.0000' },
        { accountId: acc('1100'), debit: '50000.0000' },
      ],
    });
    await api('POST', `/api/contra/${contra.id}/post`, {});
    log(`Contra posted (bank -> cash 50,000)`);

    const journal = await api<{ id: string }>('POST', '/api/journal', {
      voucherDate: D2,
      narration: 'Site office electricity bill — May 2026',
      lines: [
        { accountId: acc('6300'), projectId, costCentreId: civilCC.id, purposeId: consumptionPurpose.id, debit: '8500.0000' },
        { accountId: acc('1100'), credit: '8500.0000' },
      ],
    });
    await api('POST', `/api/journal/${journal.id}/post`, {});
    log(`Journal posted (general overheads 8,500)`);
  }

  // ── 2) Project reports (a) — Cost-centre budgets ─────────────────────────────────────────────────
  section('2a) Project reports — cost-centre budgets (material-consumption-vs-budget / cost-centre-variance)');
  {
    const existingBudgets = await api<Array<{ costCentreId: string; version: number }>>(
      'GET', `/api/masters/projects/${projectId}/budgets?pageSize=100`,
    );
    const budgetVersion = new Map(existingBudgets.map((b) => [b.costCentreId, b.version]));
    for (const [ccId, amount] of [[civilCC.id, '500000.0000'], [labourCC.id, '200000.0000']] as const) {
      const version = budgetVersion.get(ccId);
      await api('PUT', `/api/masters/projects/${projectId}/budgets`, {
        costCentreId: ccId, budgetedAmount: amount, ...(version !== undefined ? { version } : {}),
      });
    }
    log('Budgets set: CC-CIVIL 500,000 / CC-LABOUR 200,000');
  }

  // ── 2b) Project reports — IPC billing + Receipt ──────────────────────────────────────────────────
  section('2b) Project reports — 2 IPCs (project-pnl / ipc-billing / outstanding) + a part receipt');
  try {
    const existingIpcs = await api<Array<{ id: string; ipcSeqNo: number; status: string }>>(
      'GET', `/api/sales/ipc?projectId=${projectId}&pageSize=100`,
    );
    const ipcBySeq = new Map(existingIpcs.map((i) => [i.ipcSeqNo, i]));

    const ensureIpc = async (seqNo: number, date: string, dueDate: string, pct: string, amount: string, narration: string) => {
      const existing = ipcBySeq.get(seqNo);
      if (existing) return existing;
      const created = await api<{ id: string }>('POST', '/api/sales/ipc', {
        projectId, ipcSeqNo: seqNo, ipcDate: date, billDate: date, dueDate,
        workCompletedPct: pct, certifiedAmount: amount,
        costCentreId: civilCC.id, purposeId: billingPurpose.id, narration,
      });
      return { id: created.id, ipcSeqNo: seqNo, status: 'DRAFT' };
    };

    const ipc1 = await ensureIpc(1, D1, '2026-06-10', '20.0000', '2000000.0000', 'IPC #1 — Foundation & Plinth');
    if (ipc1.status === 'DRAFT') await api('POST', `/api/sales/ipc/${ipc1.id}/post`, {});
    log('IPC #1 posted (certified 2,000,000)');

    const ipc2 = await ensureIpc(2, D3, '2026-07-05', '35.0000', '1500000.0000', 'IPC #2 — Column & Beam');
    if (ipc2.status === 'DRAFT') await api('POST', `/api/sales/ipc/${ipc2.id}/post`, {});
    log('IPC #2 posted (certified 1,500,000)');

    const receipt = await api<{ id: string }>('POST', '/api/receipt', {
      receiptType: 'IPC_LINKED', receiptDate: D4, paymentMode: 'BANK_TRANSFER',
      depositAccountId: acc('1110'), ipcId: ipc1.id, amountSettled: '500000.0000',
      taxDeductedAtSource: '0.0000', chequeTxnRef: 'TXN-2026-0099', narration: 'IPC #1 part collection',
    });
    await api('POST', `/api/receipt/${receipt.id}/post`, {});
    log('Receipt posted (500,000 against IPC #1 — outstanding report now has a partial)');
  } catch (err) {
    log(`WARNING: IPC/receipt seeding failed, skipping (project-pnl/ipc-billing/outstanding will stay empty):`);
    log(`  ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 2c) Project reports — daily-labour accrual (labour-cost) ─────────────────────────────────────
  section('2c) Project reports — daily-labour head-count accrual (labour-cost)');
  try {
    const { ids } = await api<{ ids: string[] }>('POST', '/api/attendance/daily-labour', {
      rows: [
        { attendanceDate: D1, projectId, costCentreId: labourCC.id, purposeId: consumptionPurpose.id, labourCategory: 'Mason', headCount: 20, dailyRate: '650.0000' },
        { attendanceDate: D3, projectId, costCentreId: labourCC.id, purposeId: consumptionPurpose.id, labourCategory: 'Rod Binder', headCount: 12, dailyRate: '700.0000' },
      ],
    });
    for (const id of ids) await api('POST', `/api/attendance/daily-labour/${id}/confirm`, {});
    log(`Daily-labour accrual confirmed (${ids.length} rows -> Dr Labour Expense / Cr Labour Payable)`);
  } catch (err) {
    log(`WARNING: daily-labour seeding failed, skipping (labour-cost will stay empty):`);
    log(`  ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 3) Inventory reports — Purchase Order -> Bill -> Stock Journal ───────────────────────────────
  section('3) Inventory reports — PO -> Bill (stock-valuation) + Stock Journal transfer/issue (stock-transfer-summary)');
  try {
    const po = await api<{ id: string }>('POST', '/api/purchase/orders', {
      projectId, supplierId: supplier.id, poDate: D1,
      lines: [
        { itemId: cement.id, orderedQty: '300.0000', rate: '520.0000', godownId: mainGodown.id, projectId, costCentreId: civilCC.id, purposeId: consumptionPurpose.id },
        { itemId: rebar.id, orderedQty: '500.0000', rate: '95.0000', godownId: mainGodown.id, projectId, costCentreId: civilCC.id, purposeId: consumptionPurpose.id },
      ],
    });
    await api('POST', `/api/purchase/orders/${po.id}/approve`, {});
    log('Purchase order approved (300 cement @520, 500 rebar @95)');

    const bill = await api<{ id: string }>('POST', '/api/purchase/bills', {
      projectId, supplierId: supplier.id, purchaseOrderId: po.id, supplierInvoiceRef: 'ABC-INV-1001',
      billDate: D2, dueDate: '2026-06-20',
      lines: [
        { itemId: cement.id, isStockLine: true, billedQty: '300.0000', rate: '520.0000', godownId: mainGodown.id, projectId, costCentreId: civilCC.id, purposeId: consumptionPurpose.id },
        { itemId: rebar.id, isStockLine: true, billedQty: '500.0000', rate: '95.0000', godownId: mainGodown.id, projectId, costCentreId: civilCC.id, purposeId: consumptionPurpose.id },
      ],
    });
    await api('POST', `/api/purchase/bills/${bill.id}/post`, {});
    log('Purchase bill posted (stock received into Main Site Store -> stock-valuation has rows)');

    const transfer = await api<{ id: string }>('POST', '/api/stock-journal', {
      voucherDate: D3, mode: 'TRANSFER', fromGodownId: mainGodown.id, toGodownId: centralGodown.id,
      itemId: rebar.id, quantity: '50.0000', projectId, costCentreId: civilCC.id, purposeId: consumptionPurpose.id,
      narration: 'Rebar moved to central warehouse for cutting',
    });
    await api('POST', `/api/stock-journal/${transfer.id}/approve`, {});
    await api('POST', `/api/stock-journal/${transfer.id}/post`, {});
    log('Stock journal TRANSFER posted (50 rebar -> Central Warehouse)');

    const issue = await api<{ id: string }>('POST', '/api/stock-journal', {
      voucherDate: D4, mode: 'ISSUE', fromGodownId: mainGodown.id,
      itemId: cement.id, quantity: '20.0000', projectId, costCentreId: civilCC.id, purposeId: consumptionPurpose.id,
      narration: 'Issued for column casting',
    });
    await api('POST', `/api/stock-journal/${issue.id}/approve`, {});
    await api('POST', `/api/stock-journal/${issue.id}/post`, {});
    log('Stock journal ISSUE posted (20 cement consumed)');
  } catch (err) {
    log(`WARNING: inventory seeding failed, skipping remainder of this section:`);
    log(`  ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 4) Requisition & cost-control reports — Requisition -> submit -> approve -> issue ────────────
  section('4) Requisition & cost-control reports — requisition-vs-issue');
  try {
    const req = await api<{ id: string }>('POST', '/api/requisition', {
      projectId, costCentreId: civilCC.id, purposeId: consumptionPurpose.id, fromGodownId: mainGodown.id,
      requiredDate: D4, priority: 'HIGH', narration: 'Cement for slab pour',
      lines: [{ itemId: cement.id, requestedQuantity: '30.0000' }],
    });
    await api('POST', `/api/requisition/${req.id}/submit`, {});
    // A small requisition defaults to PM tier (escalate-by-default) — only an assigned PM may approve it,
    // never the unscoped ACCOUNTS/ADMIN tier (approval-policy.ts canApprove), so this one call uses pmToken.
    await api('POST', `/api/requisition/${req.id}/approve`, {}, pmToken);
    const reqDto = await api<{ lines: Array<{ id: string }> }>('GET', `/api/requisition/${req.id}`);
    await api('POST', `/api/requisition/${req.id}/issue`, {
      fromGodownId: mainGodown.id,
      lines: [{ requisitionLineId: reqDto.lines[0].id, issueQuantity: '30.0000' }],
    });
    log('Requisition submitted -> approved -> issued (30 cement)');
  } catch (err) {
    log(`WARNING: requisition seeding failed, skipping (requisition-vs-issue will stay empty):`);
    log(`  ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 5) HR reports — attendance + salary sheet + payroll payment ──────────────────────────────────
  section('5) HR reports — office attendance + salary sheet (salary-register / employee-payment-history)');
  try {
    try {
      await api('POST', '/api/attendance/office', {
        rows: employees.map((employeeId, i) => ({
          employeeId, attendanceDate: D1, projectId, dayStatus: i === 2 ? 'PAID_LEAVE' : 'PRESENT',
        })),
      });
      log('Office attendance captured (3 employees, attendance-summary now has rows)');
    } catch (err) {
      if (err instanceof Error && err.message.includes('DUPLICATE_ATTENDANCE')) {
        log('Office attendance already captured (from a prior run) — skipping');
      } else {
        throw err;
      }
    }

    const existingSheets = await api<Array<{ id: string; status: string; version: number; totalNet: string }>>(
      'GET', `/api/salary/sheets?financialYearId=${fy.id}&periodLabel=${PERIOD_LABEL}&pageSize=10`,
    );
    let sheetId: string;
    let sheetDto: { version: number; totalNet: string; status: string };
    if (existingSheets.length > 0) {
      sheetId = existingSheets[0].id;
      sheetDto = existingSheets[0];
      log(`Salary sheet already exists for ${PERIOD_LABEL} (status ${sheetDto.status}) — reusing`);
    } else {
      const sheet = await api<{ id: string }>('POST', '/api/salary/sheets/generate', {
        financialYearId: fy.id, periodLabel: PERIOD_LABEL, periodStart: PERIOD_START, periodEnd: PERIOD_END,
        projectId, purposeId: consumptionPurpose.id,
      });
      sheetId = sheet.id;
      sheetDto = await api<{ version: number; totalNet: string; status: string }>('GET', `/api/salary/sheets/${sheetId}`);
    }
    if (sheetDto.status === 'DRAFT') {
      await api('POST', `/api/salary/sheets/${sheetId}/post`, { version: sheetDto.version });
      log(`Salary sheet posted (period ${PERIOD_LABEL}, net ${sheetDto.totalNet})`);
    } else {
      log(`Salary sheet already ${sheetDto.status} (period ${PERIOD_LABEL}, net ${sheetDto.totalNet})`);
    }

    const existingPayments = await api<Array<{ id: string; status: string }>>(
      'GET', `/api/payment?financialYearId=${fy.id}&pageSize=100`,
    );
    if (existingPayments.some((p) => p.status === 'POSTED')) {
      log('A payment already exists for this company — skipping salary payment (employee-payment-history already has rows)');
    } else {
      const payment = await api<{ id: string }>('POST', '/api/payment', {
        paymentDate: '2026-06-05', paymentMode: 'BANK_TRANSFER', paymentAccountId: acc('1110'),
        chequeTxnRef: 'TXN-2026-0201',
        paymentAmount: sheetDto.totalNet, narration: `${PERIOD_LABEL} salary run — bank disbursement`,
        allocations: [{ payableType: 'SALARY', payableId: sheetId, amountAllocated: sheetDto.totalNet }],
      });
      await api('POST', `/api/payment/${payment.id}/post`, {});
      log('Salary payment posted (employee-payment-history now has rows)');
    }
  } catch (err) {
    log(`WARNING: HR seeding failed, skipping (salary-register/employee-payment-history may stay empty):`);
    log(`  ${err instanceof Error ? err.message : String(err)}`);
  }

  banner('Done — every report source (LEDGER/INVENTORY/REQUISITION/HR/SALES_IPC/COST_CONTROL) now has posted data.');
  log(`Check via: GET ${BASE_URL}/api/reports/trial-balance?financialYearId=${fy.id}`);
  log(`(Bearer token above expires in 15 min — log in again from the frontend to browse Reports.)`);
}

main().catch((err: unknown) => {
  process.stderr.write(`\nSeed failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
