/**
 * Purchase & Inventory sample-data seed — so the Purchase and Inventory modules aren't empty in a local/
 * dev database. Adds 3 Purchase Orders, 3 GRNs, 3 Purchase Bills, 2 extra Items and 3 Stock Journals.
 *
 * Why this script CAN insert real rows directly (raw SQL) while still honouring CLAUDE.md's "one posting
 * layer" / "never pre-allocate a voucher number" rules — verified against the actual entities/migrations,
 * not assumed:
 *   - `purchase_order` is a NON-POSTING commitment document (FR-PUR-001): the table has no
 *     `journal_entry_id` / `entry_no` column at all, in any status. Safe in DRAFT or APPROVED.
 *   - `grn` NEVER writes a ledger entry or a stock_movement row, in ANY status (design §10 Q4, option
 *     (a) — "received = billed at bill post"; the table has no `journal_entry_id`/stock reference column
 *     either). Safe even marked POSTED.
 *   - `purchase_bill` and `stock_journal` DO post to the ledger (and, for the bill, to stock) — but ONLY
 *     when their `status` flips to POSTED, which is exactly when `entry_no`/`journal_entry_id` (and, for
 *     the stock journal, `posted_at`) get set. This script inserts them as DRAFT (bill) / DRAFT|APPROVED
 *     (stock journal) ONLY, leaving those columns NULL — so PostingService's write path is never touched
 *     and no voucher number is ever pre-allocated. To see the real ledger/stock effect, POST them through
 *     the API — this script prints the exact calls at the end (same idea as seed-workflow-demo.ts step 5).
 *
 * Prerequisite: `npm run seed` AND `npm run seed:workflow-demo` must have already run (company, FY, CoA,
 * users, project PRJ-DEMO-01, cost centre CC-CIVIL, godown "Main Site Store", purpose "Site Consumption",
 * supplier "ABC Building Materials Ltd", items CEMENT-OPC/REBAR-12MM).
 *
 * Usage:
 *   npm run seed:purchase-inventory-demo
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../data-source';

dotenv.config();

// ── Configuration ─────────────────────────────────────────────────────────────

const COMPANY_NAME = 'Zakir Enterprise'; // must match seed.ts
const FY_LABEL = 'FY 2025-26'; // must match seed.ts
const SEED_PASSWORD = 'ZE@dev2025!'; // must match seed.ts

const PROJECT_CODE = 'PRJ-DEMO-01'; // must match seed-workflow-demo.ts
const COST_CENTRE_CODE = 'CC-CIVIL'; // must match seed-workflow-demo.ts
const GODOWN_NAME = 'Main Site Store'; // must match seed-workflow-demo.ts
const PURPOSE_NAME = 'Site Consumption'; // must match seed-workflow-demo.ts
const SUPPLIER_NAME = 'ABC Building Materials Ltd'; // must match seed-workflow-demo.ts
const ITEM_CODES = ['CEMENT-OPC', 'REBAR-12MM']; // must match seed-workflow-demo.ts
const INVENTORY_ACCOUNT_CODE = '1300';

const CENTRAL_GODOWN_NAME = 'Central Warehouse'; // same name seed-module-samples.ts uses, if it ran too

const NEW_SUPPLIER = { name: 'Bengal Steel & Cement Suppliers', phone: '+8801711000003' };

const NEW_ITEMS = [
  { code: 'BRICK-1ST', name: '1st Class Brick', uom: 'PCS' },
  { code: 'SAND-COARSE', name: 'Coarse Sand', uom: 'CFT' },
];

// Voucher dates safely inside FY 2025-26 (2025-07-01 → 2026-06-30).
const DATES = {
  po1: '2026-05-20',
  po2: '2026-05-22',
  po3: '2026-06-01',
  grn1: '2026-05-25',
  grn2: '2026-05-27',
  grn3: '2026-06-05',
  bill1: '2026-05-26',
  due1: '2026-06-10',
  bill2: '2026-05-28',
  due2: '2026-06-12',
  bill3: '2026-06-06',
  due3: '2026-06-21',
  sj1: '2026-06-10',
  sj2: '2026-06-12',
  sj3: '2026-06-15',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(`  ${msg}\n`);
}

function banner(msg: string): void {
  process.stdout.write(`\n${'═'.repeat(78)}\n  ${msg}\n${'═'.repeat(78)}\n`);
}

function section(msg: string): void {
  process.stdout.write(`\n  ── ${msg} ${'─'.repeat(Math.max(0, 70 - msg.length))}\n`);
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

function money(v: Decimal): string {
  return v.toFixed(4);
}

// ── Ensure functions (idempotent — check natural key, insert if missing) ──────

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

async function ensureSupplier(
  ds: DataSource,
  companyId: string,
  p: { name: string; phone: string },
): Promise<string> {
  const rows = await ds.query(`SELECT id FROM "party" WHERE company_id = $1 AND name = $2 LIMIT 1`, [
    companyId,
    p.name,
  ]);
  if (rows.length > 0) {
    log(`Supplier exists         → ${p.name} (${rows[0].id})`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "party" (id, company_id, name, is_customer, is_supplier, phone, is_active, version)
     VALUES ($1, $2, $3, false, true, $4, true, 1)`,
    [id, companyId, p.name, p.phone],
  );
  log(`Supplier created        → ${p.name} (${id})`);
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

// ── Purchase Order (+ line) — non-posting document, safe in any status ────────

interface PoDim {
  companyId: string;
  financialYearId: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  godownId: string;
}

async function ensurePurchaseOrder(
  ds: DataSource,
  dim: PoDim,
  po: {
    poRefNo: string;
    poDate: string;
    supplierId: string;
    status: string;
    approvedById: string | null;
    narration: string;
    itemId: string;
    orderedQty: Decimal;
    rate: Decimal;
  },
): Promise<{ id: string; lineId: string }> {
  const existing = await ds.query(
    `SELECT po.id, l.id AS line_id FROM "purchase_order" po
       JOIN "purchase_order_line" l ON l.purchase_order_id = po.id
     WHERE po.company_id = $1 AND po.po_ref_no = $2 LIMIT 1`,
    [dim.companyId, po.poRefNo],
  );
  if (existing.length > 0) {
    log(`Purchase Order exists   → ${po.poRefNo} (${existing[0].id})`);
    return { id: existing[0].id, lineId: existing[0].line_id };
  }

  const id = crypto.randomUUID();
  const lineId = crypto.randomUUID();
  const lineAmount = po.orderedQty.times(po.rate);
  const approvedAt = po.status === 'APPROVED' ? new Date() : null;

  await ds.query(
    `INSERT INTO "purchase_order"
       (id, company_id, financial_year_id, project_id, supplier_id, po_ref_no, po_date, status,
        narration, approved_by, approved_at, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1)`,
    [
      id,
      dim.companyId,
      dim.financialYearId,
      dim.projectId,
      po.supplierId,
      po.poRefNo,
      po.poDate,
      po.status,
      po.narration,
      po.approvedById,
      approvedAt,
    ],
  );
  await ds.query(
    `INSERT INTO "purchase_order_line"
       (id, purchase_order_id, line_no, item_id, ordered_qty, rate, line_amount, godown_id,
        project_id, cost_centre_id, purpose_id, billed_qty, received_qty)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0)`,
    [
      lineId,
      id,
      po.itemId,
      money(po.orderedQty),
      money(po.rate),
      money(lineAmount),
      dim.godownId,
      dim.projectId,
      dim.costCentreId,
      dim.purposeId,
    ],
  );
  log(`Purchase Order created  → ${po.poRefNo} — ${po.status} (${id})`);
  return { id, lineId };
}

// ── GRN (+ line) — informational receipt, never touches ledger/stock ──────────

async function ensureGrn(
  ds: DataSource,
  dim: PoDim,
  grn: {
    grnRefNo: string;
    receiptDate: string;
    supplierId: string;
    purchaseOrderId: string;
    poLineId: string;
    status: string;
    receivedById: string;
    narration: string;
    itemId: string;
    receivedQty: Decimal;
    rate: Decimal;
  },
): Promise<string> {
  const existing = await ds.query(`SELECT id FROM "grn" WHERE company_id = $1 AND grn_ref_no = $2 LIMIT 1`, [
    dim.companyId,
    grn.grnRefNo,
  ]);
  if (existing.length > 0) {
    log(`GRN exists              → ${grn.grnRefNo} (${existing[0].id})`);
    return existing[0].id;
  }

  const id = crypto.randomUUID();
  const receivedValue = grn.receivedQty.times(grn.rate);
  const posted = grn.status === 'POSTED';

  await ds.query(
    `INSERT INTO "grn"
       (id, company_id, financial_year_id, project_id, supplier_id, purchase_order_id, grn_ref_no,
        receipt_date, status, received_by, narration, posted_at, posted_by, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1)`,
    [
      id,
      dim.companyId,
      dim.financialYearId,
      dim.projectId,
      grn.supplierId,
      grn.purchaseOrderId,
      grn.grnRefNo,
      grn.receiptDate,
      grn.status,
      grn.receivedById,
      grn.narration,
      posted ? new Date() : null,
      posted ? grn.receivedById : null,
    ],
  );
  await ds.query(
    `INSERT INTO "grn_line"
       (id, grn_id, line_no, item_id, received_qty, rate, received_value, godown_id,
        project_id, cost_centre_id, purpose_id)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      crypto.randomUUID(),
      id,
      grn.itemId,
      money(grn.receivedQty),
      money(grn.rate),
      money(receivedValue),
      dim.godownId,
      dim.projectId,
      dim.costCentreId,
      dim.purposeId,
    ],
  );
  log(`GRN created             → ${grn.grnRefNo} — ${grn.status} (${id})`);

  // Keep the PO line's derived received_qty roll-up consistent with a POSTED GRN (mirrors what the real
  // GRN-post use case would update — see FR-PUR-018).
  if (posted) {
    await ds.query(`UPDATE "purchase_order_line" SET received_qty = received_qty + $1 WHERE id = $2`, [
      money(grn.receivedQty),
      grn.poLineId,
    ]);
  }
  return id;
}

// ── Purchase Bill (+ line) — DRAFT only (never posted by this script) ─────────

async function ensurePurchaseBill(
  ds: DataSource,
  dim: PoDim,
  bill: {
    supplierInvoiceRef: string;
    billDate: string;
    dueDate: string;
    supplierId: string;
    purchaseOrderId: string | null;
    narration: string;
    itemId: string;
    billedQty: Decimal;
    rate: Decimal;
  },
): Promise<string> {
  const existing = await ds.query(
    `SELECT id FROM "purchase_bill" WHERE company_id = $1 AND supplier_invoice_ref = $2 LIMIT 1`,
    [dim.companyId, bill.supplierInvoiceRef],
  );
  if (existing.length > 0) {
    log(`Purchase Bill exists    → ${bill.supplierInvoiceRef} (${existing[0].id})`);
    return existing[0].id;
  }

  const id = crypto.randomUUID();
  const lineAmount = bill.billedQty.times(bill.rate);
  const grossAmount = lineAmount;
  const netPayable = grossAmount; // VAT/TDS/AIT left at 0 for this demo seed.

  await ds.query(
    `INSERT INTO "purchase_bill"
       (id, company_id, financial_year_id, project_id, supplier_id, purchase_order_id,
        supplier_invoice_ref, bill_date, due_date, gross_amount, vat_input_amount, tds_amount,
        ait_amount, net_payable_amount, narration, status, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0, 0, $11, $12, 'DRAFT', 1)`,
    [
      id,
      dim.companyId,
      dim.financialYearId,
      dim.projectId,
      bill.supplierId,
      bill.purchaseOrderId,
      bill.supplierInvoiceRef,
      bill.billDate,
      bill.dueDate,
      money(grossAmount),
      money(netPayable),
      bill.narration,
    ],
  );
  await ds.query(
    `INSERT INTO "purchase_bill_line"
       (id, purchase_bill_id, line_no, item_id, is_stock_line, billed_qty, rate, line_amount,
        vat_input_amount, tds_amount, ait_amount, godown_id, project_id, cost_centre_id, purpose_id,
        received_qty)
     VALUES ($1, $2, 1, $3, true, $4, $5, $6, 0, 0, 0, $7, $8, $9, $10, 0)`,
    [
      crypto.randomUUID(),
      id,
      bill.itemId,
      money(bill.billedQty),
      money(bill.rate),
      money(lineAmount),
      dim.godownId,
      dim.projectId,
      dim.costCentreId,
      dim.purposeId,
    ],
  );
  log(`Purchase Bill created   → ${bill.supplierInvoiceRef} — DRAFT (${id})`);
  return id;
}

// ── Stock Journal (+ lines) — DRAFT/APPROVED only (never posted by this script) ─

async function ensureStockJournal(
  ds: DataSource,
  dim: PoDim,
  sj: {
    voucherDate: string;
    mode: 'TRANSFER' | 'ISSUE';
    fromGodownId: string;
    toGodownId: string | null;
    itemId: string;
    quantity: Decimal;
    status: 'DRAFT' | 'APPROVED';
    issuedById: string;
    receivedById: string | null;
    approvedById: string | null;
    narration: string;
  },
): Promise<string> {
  const existing = await ds.query(
    `SELECT id FROM "stock_journal"
     WHERE company_id = $1 AND item_id = $2 AND voucher_date = $3 AND mode = $4 LIMIT 1`,
    [dim.companyId, sj.itemId, sj.voucherDate, sj.mode],
  );
  if (existing.length > 0) {
    log(`Stock Journal exists    → ${sj.mode} ${sj.voucherDate} (${existing[0].id})`);
    return existing[0].id;
  }

  const id = crypto.randomUUID();
  const approvedAt = sj.status === 'APPROVED' ? new Date() : null;

  await ds.query(
    `INSERT INTO "stock_journal"
       (id, company_id, financial_year_id, voucher_date, mode, status, from_godown_id, to_godown_id,
        item_id, quantity, project_id, cost_centre_id, purpose_id, issued_by_id, received_by_id,
        approved_by_id, approved_at, narration, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 1)`,
    [
      id,
      dim.companyId,
      dim.financialYearId,
      sj.voucherDate,
      sj.mode,
      sj.status,
      sj.fromGodownId,
      sj.toGodownId,
      sj.itemId,
      money(sj.quantity),
      dim.projectId,
      dim.costCentreId,
      dim.purposeId,
      sj.issuedById,
      sj.receivedById,
      sj.approvedById,
      approvedAt,
      sj.narration,
    ],
  );

  const lines: Array<{ side: 'OUT' | 'IN'; godownId: string }> = [{ side: 'OUT', godownId: sj.fromGodownId }];
  if (sj.toGodownId) lines.push({ side: 'IN', godownId: sj.toGodownId });

  let lineNo = 1;
  for (const line of lines) {
    await ds.query(
      `INSERT INTO "stock_journal_line"
         (id, stock_journal_id, line_no, side, godown_id, item_id, quantity, project_id,
          cost_centre_id, purpose_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        crypto.randomUUID(),
        id,
        lineNo++,
        line.side,
        line.godownId,
        sj.itemId,
        money(sj.quantity),
        dim.projectId,
        dim.costCentreId,
        dim.purposeId,
      ],
    );
  }
  log(`Stock Journal created   → ${sj.mode} ${sj.voucherDate} — ${sj.status} (${id})`);
  return id;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner('ZE-ERP — Purchase & Inventory sample-data seed');

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

  const fy = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "financial_year" WHERE company_id = $1 AND label = $2 LIMIT 1`,
    [companyId, FY_LABEL],
    `Financial year "${FY_LABEL}" not found. Run "npm run seed" first.`,
  );

  const invAccount = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "account" WHERE company_id = $1 AND code = $2 LIMIT 1`,
    [companyId, INVENTORY_ACCOUNT_CODE],
    `Account "${INVENTORY_ACCOUNT_CODE}" (Inventory) not found. Run "npm run seed" first.`,
  );

  const project = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "project" WHERE company_id = $1 AND project_code = $2 LIMIT 1`,
    [companyId, PROJECT_CODE],
    `Project "${PROJECT_CODE}" not found. Run "npm run seed:workflow-demo" first.`,
  );
  const projectId = project.id;

  const costCentre = await mustGet<{ id: string }>(
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

  const purpose = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "purpose" WHERE project_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [projectId, PURPOSE_NAME],
    `Purpose "${PURPOSE_NAME}" not found. Run "npm run seed:workflow-demo" first.`,
  );

  const abcSupplier = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "party" WHERE company_id = $1 AND name = $2 LIMIT 1`,
    [companyId, SUPPLIER_NAME],
    `Supplier "${SUPPLIER_NAME}" not found. Run "npm run seed:workflow-demo" first.`,
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

  const pmUser = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "user" WHERE company_id = $1 AND email = $2 LIMIT 1`,
    [companyId, 'pm@ze.local'],
    `User "pm@ze.local" not found. Run "npm run seed" first.`,
  );
  const storekeeper = await mustGet<{ id: string }>(
    ds,
    `SELECT id FROM "user" WHERE company_id = $1 AND email = $2 LIMIT 1`,
    [companyId, 'storekeeper@ze.local'],
    `User "storekeeper@ze.local" not found. Run "npm run seed" first.`,
  );

  section('Additional master data');

  const centralGodown = await ensureGodown(ds, companyId, projectId, CENTRAL_GODOWN_NAME);
  const bengalSupplier = await ensureSupplier(ds, companyId, NEW_SUPPLIER);
  for (const item of NEW_ITEMS) {
    itemIds[item.code] = await ensureItem(ds, companyId, invAccount.id, item);
  }

  const dim: PoDim = {
    companyId,
    financialYearId: fy.id,
    projectId,
    costCentreId: costCentre.id,
    purposeId: purpose.id,
    godownId: mainGodown.id,
  };

  section('Purchase Orders (non-posting — safe to seed directly, FR-PUR-001)');

  const po1 = await ensurePurchaseOrder(ds, dim, {
    poRefNo: 'PO-DEMO-001',
    poDate: DATES.po1,
    supplierId: abcSupplier.id,
    status: 'APPROVED',
    approvedById: pmUser.id,
    narration: 'OPC Cement for foundation works',
    itemId: itemIds['CEMENT-OPC'],
    orderedQty: new Decimal('500.0000'),
    rate: new Decimal('520.0000'),
  });
  const po2 = await ensurePurchaseOrder(ds, dim, {
    poRefNo: 'PO-DEMO-002',
    poDate: DATES.po2,
    supplierId: abcSupplier.id,
    status: 'APPROVED',
    approvedById: pmUser.id,
    narration: 'MS Rebar for column & beam works',
    itemId: itemIds['REBAR-12MM'],
    orderedQty: new Decimal('2000.0000'),
    rate: new Decimal('95.0000'),
  });
  const po3 = await ensurePurchaseOrder(ds, dim, {
    poRefNo: 'PO-DEMO-003',
    poDate: DATES.po3,
    supplierId: bengalSupplier,
    status: 'DRAFT',
    approvedById: null,
    narration: '1st class brick for boundary wall',
    itemId: itemIds['BRICK-1ST'],
    orderedQty: new Decimal('10000.0000'),
    rate: new Decimal('9.5000'),
  });

  section('GRNs (informational receipt — never touches ledger/stock, design §10 Q4)');

  await ensureGrn(ds, dim, {
    grnRefNo: 'GRN-DEMO-001',
    receiptDate: DATES.grn1,
    supplierId: abcSupplier.id,
    purchaseOrderId: po1.id,
    poLineId: po1.lineId,
    status: 'POSTED',
    receivedById: storekeeper.id,
    narration: 'Full receipt against PO-DEMO-001',
    itemId: itemIds['CEMENT-OPC'],
    receivedQty: new Decimal('500.0000'),
    rate: new Decimal('520.0000'),
  });
  await ensureGrn(ds, dim, {
    grnRefNo: 'GRN-DEMO-002',
    receiptDate: DATES.grn2,
    supplierId: abcSupplier.id,
    purchaseOrderId: po2.id,
    poLineId: po2.lineId,
    status: 'POSTED',
    receivedById: storekeeper.id,
    narration: 'Partial receipt against PO-DEMO-002 (1500 of 2000 KG)',
    itemId: itemIds['REBAR-12MM'],
    receivedQty: new Decimal('1500.0000'),
    rate: new Decimal('95.0000'),
  });
  await ensureGrn(ds, dim, {
    grnRefNo: 'GRN-DEMO-003',
    receiptDate: DATES.grn3,
    supplierId: bengalSupplier,
    purchaseOrderId: po3.id,
    poLineId: po3.lineId,
    status: 'DRAFT',
    receivedById: storekeeper.id,
    narration: 'Awaiting confirmation — against PO-DEMO-003',
    itemId: itemIds['BRICK-1ST'],
    receivedQty: new Decimal('10000.0000'),
    rate: new Decimal('9.5000'),
  });

  section('Purchase Bills (DRAFT only — posting is left to the real API/PostingService)');

  await ensurePurchaseBill(ds, dim, {
    supplierInvoiceRef: 'INV-ABC-1001',
    billDate: DATES.bill1,
    dueDate: DATES.due1,
    supplierId: abcSupplier.id,
    purchaseOrderId: po1.id,
    narration: 'Bill against PO-DEMO-001',
    itemId: itemIds['CEMENT-OPC'],
    billedQty: new Decimal('500.0000'),
    rate: new Decimal('520.0000'),
  });
  await ensurePurchaseBill(ds, dim, {
    supplierInvoiceRef: 'INV-ABC-1002',
    billDate: DATES.bill2,
    dueDate: DATES.due2,
    supplierId: abcSupplier.id,
    purchaseOrderId: po2.id,
    narration: 'Bill against PO-DEMO-002 (partial, 1500 of 2000 KG)',
    itemId: itemIds['REBAR-12MM'],
    billedQty: new Decimal('1500.0000'),
    rate: new Decimal('95.0000'),
  });
  await ensurePurchaseBill(ds, dim, {
    supplierInvoiceRef: 'INV-BSC-2001',
    billDate: DATES.bill3,
    dueDate: DATES.due3,
    supplierId: bengalSupplier,
    purchaseOrderId: null, // direct purchase — no PO reference (FR-PUR-003)
    narration: 'Direct purchase — brick, no PO',
    itemId: itemIds['BRICK-1ST'],
    billedQty: new Decimal('10000.0000'),
    rate: new Decimal('9.5000'),
  });

  section('Stock Journals (DRAFT/APPROVED only — posting is left to the real API/PostingService)');

  await ensureStockJournal(ds, dim, {
    voucherDate: DATES.sj1,
    mode: 'TRANSFER',
    fromGodownId: mainGodown.id,
    toGodownId: centralGodown,
    itemId: itemIds['CEMENT-OPC'],
    quantity: new Decimal('50.0000'),
    status: 'APPROVED',
    issuedById: storekeeper.id,
    receivedById: storekeeper.id,
    approvedById: pmUser.id,
    narration: 'Transfer cement to Central Warehouse for redistribution',
  });
  await ensureStockJournal(ds, dim, {
    voucherDate: DATES.sj2,
    mode: 'TRANSFER',
    fromGodownId: mainGodown.id,
    toGodownId: centralGodown,
    itemId: itemIds['REBAR-12MM'],
    quantity: new Decimal('200.0000'),
    status: 'DRAFT',
    issuedById: storekeeper.id,
    receivedById: null,
    approvedById: null,
    narration: 'Transfer rebar to Central Warehouse — pending approval',
  });
  await ensureStockJournal(ds, dim, {
    voucherDate: DATES.sj3,
    mode: 'ISSUE',
    fromGodownId: mainGodown.id,
    toGodownId: null,
    itemId: itemIds['BRICK-1ST'],
    quantity: new Decimal('1000.0000'),
    status: 'APPROVED',
    issuedById: storekeeper.id,
    receivedById: null,
    approvedById: pmUser.id,
    narration: 'Issued to site for boundary-wall work',
  });

  await ds.destroy();

  printNextSteps({
    po1Id: po1.id,
    po2Id: po2.id,
    mainGodownId: mainGodown.id,
    cementId: itemIds['CEMENT-OPC'],
    rebarId: itemIds['REBAR-12MM'],
    projectId,
    costCentreId: costCentre.id,
    purposeId: purpose.id,
  });
}

function printNextSteps(ids: {
  po1Id: string;
  po2Id: string;
  mainGodownId: string;
  cementId: string;
  rebarId: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
}): void {
  banner('Seed complete — 3 Purchase Orders, 3 GRNs, 3 Purchase Bills (DRAFT), 3 Stock Journals (draft/approved)');
  log(`Login as pm@ze.local / storekeeper@ze.local, password: ${SEED_PASSWORD}`);
  log('');
  log('These rows are already visible in list/detail screens & DB queries right now. To also see the');
  log('real ledger/stock effect (journal_entry, stock_movement, stock_balance), POST the bill/stock');
  log('journal through the real API — that is what actually invokes PostingService:');
  log('');

  section('Post a Purchase Bill (rolls stock via INV.receiveIn + posts the ledger)');
  payload('POST', `/api/purchase/bills/${'<bill-id-for-INV-ABC-1001>'}/post`);

  section('Post a Stock Journal (TRANSFER — value-neutral, no ledger entry, still moves stock)');
  payload('POST', `/api/stock-journal/${'<stock-journal-id-for-2026-06-10-TRANSFER>'}/post`);

  section('Or create fresh ones from scratch via the API');
  payload('POST', '/api/purchase/orders', {
    projectId: ids.projectId,
    supplierId: '<supplier-id>',
    poDate: '2026-06-20',
    lines: [
      {
        itemId: ids.cementId,
        orderedQty: '100.0000',
        rate: '520.0000',
        godownId: ids.mainGodownId,
        costCentreId: ids.costCentreId,
        purposeId: ids.purposeId,
      },
    ],
  });

  banner('Done');
}

main().catch((err: unknown) => {
  process.stderr.write(`\nSeed failed: ${String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
