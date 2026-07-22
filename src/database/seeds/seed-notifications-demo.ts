/**
 * Notifications demo-data seed — inserts N (default 100) notification rows for ONE recipient so the
 * bell drawer + `/notifications` page (feed, unread count, pagination, and the drawer's
 * infinite-scroll-once-implemented) have enough data to exercise end-to-end.
 *
 * Notifications are NOT the ledger, so the "one posting layer" rule does not apply — this writes the
 * `notification` table directly (append-only; the only mutation in real life is read-state). Types,
 * severities and source modules are drawn from the real Notification Type Catalogue
 * (src/core/notifications/domain/notification-catalog.ts) so every row is catalogue-valid.
 *
 * Re-runnable: it first deletes this user's prior seed rows (event_key LIKE 'seed-notif-%'), then
 * re-inserts, so the count stays exactly N. Real (non-seed) notifications are left untouched.
 *
 * Usage:
 *   npm run seed:notifications-demo
 *   SEED_NOTIF_EMAIL=pm@ze.local SEED_NOTIF_COUNT=250 npm run seed:notifications-demo
 *
 * Prerequisite: `npm run seed` (company + users must exist).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../data-source';
import { NOTIFICATION_TYPES, NotificationTypeDef } from '../../core/notifications/domain/notification-catalog';

dotenv.config();

const COMPANY_NAME = 'Zakir Enterprise';
const RECIPIENT_EMAIL = process.env.SEED_NOTIF_EMAIL ?? 'admin@ze.local';
const COUNT = Math.max(1, parseInt(process.env.SEED_NOTIF_COUNT ?? '100', 10));

// Realistic Bangladeshi sample data to vary the title/body per row.
const PROJECTS = ['Bridge-04 · Buriganga', 'Tower-A · Uttara', 'Depot-02 · Narayanganj', 'Road-11 · Savar'];
const PARTIES = ['M/s Rahman Traders', 'Shah Cement Ltd.', 'Meghna Steel', 'ABC Building Materials Ltd'];
const PEOPLE = ['Ashraf Uddin', 'ফারজানা আক্তার', 'Kamrul Hasan', 'Nusrat Jahan'];
const AMOUNTS = ['৳ 42,00,000.00', '৳ 8,40,000.00', '৳ 12,40,000.00', '৳ 3,20,000.00', '৳ 9,45,000.00'];

// Source module → a REAL frontend list route, so a seeded notification is clickable and
// lands on an existing page (matches src/app/(app)/**). Kept to list routes (no fabricated
// record ids); the click-through + auto-mark-read is what we exercise.
const ROUTE_BY_MODULE: Record<string, string> = {
  REQ: '/requisitions',
  PUR: '/purchase/orders',
  INV: '/inventory/stock-journals',
  SAL: '/sales/ipcs',
  REC: '/receipts',
  PAY: '/payments',
  CC: '/cost-control/budget-vs-actual',
  PER: '/period',
  HR: '/hr/salary-sheets',
  AUD: '/audit/users',
  LED: '/ledger',
};

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]!;
}
function pad(n: number): string {
  return String(100000 + n).slice(1);
}

/** A human title + body for a given catalogue type, seeded by the row index for variety. */
function message(def: NotificationTypeDef, i: number): { title: string; body: string } {
  const project = pick(PROJECTS, i);
  const party = pick(PARTIES, i + 1);
  const person = pick(PEOPLE, i + 2);
  const amount = pick(AMOUNTS, i);
  const num = pad(i + 1);
  switch (def.code) {
    case 'REQ_SUBMITTED':
      return { title: `Requisition REQ-${num} submitted`, body: `${person} raised a store requisition for ${project}.` };
    case 'REQ_APPROVED':
      return { title: `Requisition REQ-${num} approved`, body: `Your store requisition for ${project} was approved.` };
    case 'IPC_POSTED':
      return { title: `IPC-${num} certified — ${project}`, body: `${party}'s interim payment certificate for ${amount} is posted.` };
    case 'IPC_OVERDUE':
      return { title: `IPC-${num} overdue — ${project}`, body: `Payment for ${amount} against ${party} is past its due date.` };
    case 'RECEIPT_POSTED':
      return { title: `Receipt RCP-${num} posted`, body: `${amount} received from ${party} against IPC-${num}.` };
    case 'PAYMENT_POSTED':
      return { title: `Payment PAY-${num} released`, body: `${amount} paid to ${party}.` };
    case 'BUDGET_OVER':
      return { title: `Budget breach — ${project}`, body: `Actual cost has crossed the budget for this cost centre (105% used).` };
    case 'BUDGET_APPROACHING':
      return { title: `Budget approaching — ${project}`, body: `This cost centre is at 90% of its budget.` };
    case 'SALARY_POSTED':
      return { title: `Salary run posted`, body: `Monthly salary run posted — net ${amount}.` };
    case 'PAYSLIP_AVAILABLE':
      return { title: `Payslip available`, body: `${person} — your payslip for this month is ready.` };
    case 'GRN_POSTED':
      return { title: `GRN-${num} matched — ${party}`, body: `Delivery fully matched. Purchase bill BILL-${num} is ready to record.` };
    case 'STOCK_JOURNAL_POSTED':
      return { title: `Stock journal SJ-${num} posted`, body: `Material moved for ${project}.` };
    case 'PERIOD_CLOSED':
      return { title: `Accounting period closed`, body: `Posting into the closed period is now rejected.` };
    case 'USER_CREATED_WELCOME':
      return { title: `Welcome to Zakir Enterprise ERP`, body: `${person}, your account is ready. Set your password to begin.` };
    default:
      return { title: `${def.code.replace(/_/g, ' ').toLowerCase()} — ${project}`, body: `Reference ${def.sourceModule}-${num} · ${amount}.` };
  }
}

async function main(): Promise<void> {
  process.stdout.write(`\n  Notifications demo seed — ${COUNT} rows for ${RECIPIENT_EMAIL}\n`);

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

  const company = (await ds.query(`SELECT id FROM company WHERE name = $1 LIMIT 1`, [COMPANY_NAME]))[0] as { id: string } | undefined;
  if (!company) throw new Error(`Company "${COMPANY_NAME}" not found. Run "npm run seed" first.`);

  const user = (await ds.query(`SELECT id FROM "user" WHERE company_id = $1 AND email = $2 LIMIT 1`, [company.id, RECIPIENT_EMAIL]))[0] as { id: string } | undefined;
  if (!user) throw new Error(`User "${RECIPIENT_EMAIL}" not found in ${COMPANY_NAME}. Run "npm run seed" first.`);

  // Idempotent: clear this user's previous seed rows (leaves real notifications alone).
  // Count first, then delete — TypeORM's DELETE result shape is driver-specific, so a
  // separate count is the reliable way to report how many were cleared.
  const [{ c: priorCount }] = (await ds.query(
    `SELECT count(*)::int AS c FROM notification WHERE recipient_user_id = $1 AND event_key LIKE 'seed-notif-%'`,
    [user.id],
  )) as Array<{ c: number }>;
  await ds.query(
    `DELETE FROM notification WHERE recipient_user_id = $1 AND event_key LIKE 'seed-notif-%'`,
    [user.id],
  );
  process.stdout.write(`  Cleared ${priorCount} prior seed notifications\n`);

  const now = Date.now();
  let unread = 0;
  for (let i = 0; i < COUNT; i++) {
    const def = NOTIFICATION_TYPES[i % NOTIFICATION_TYPES.length]!;
    const { title, body } = message(def, i);
    // Newest first: row 0 = now, each older by ~90 min → 100 rows span ~6 days.
    const createdAt = new Date(now - i * 90 * 60 * 1000).toISOString();
    // Newest 25 unread; the rest read (gives a meaningful unread pill + pageable read history).
    const isRead = i >= 25;
    if (!isRead) unread++;
    const readAt = isRead ? new Date(now - i * 90 * 60 * 1000 + 5 * 60 * 1000).toISOString() : null;
    // Clickable → real route (row navigates there + auto-marks read). Every ~9th row is
    // informational (null deepLink) to exercise the non-clickable state too.
    const informational = i % 9 === 8;
    const deepLink = informational ? null : JSON.stringify({ route: ROUTE_BY_MODULE[def.sourceModule] ?? '/dashboard' });

    await ds.query(
      `INSERT INTO notification
         (id, company_id, recipient_user_id, type, severity, title, body,
          source_module, source_entity_type, source_entity_id, deep_link, payload,
          event_key, is_read, read_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)`,
      [
        randomUUID(), company.id, user.id, def.code, def.severity, title, body,
        def.sourceModule, null, null, deepLink, '{}',
        `seed-notif-${i}`, isRead, readAt, createdAt,
      ],
    );
  }

  process.stdout.write(`  Inserted ${COUNT} notifications (${unread} unread, ${COUNT - unread} read)\n`);
  process.stdout.write(`  Done — open the bell / /notifications as ${RECIPIENT_EMAIL} to see them.\n\n`);
  await ds.destroy();
}

main().catch((err: unknown) => {
  process.stderr.write(`\nSeed failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
