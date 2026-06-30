/**
 * Dev/staging seed CLI — idempotent bootstrap for a fresh database.
 *
 * What it does (in order, all idempotent):
 *   1. Runs all pending TypeORM migrations.
 *   2. Creates the demo company "Zakir Enterprise".
 *   3. Creates financial year FY 2025-26.
 *   4. Seeds the standard Chart of Accounts (groups + accounts).
 *   5. Seeds the six platform roles with default permission sets.
 *   6. Creates one login-ready user per role with a known temporary password.
 *
 * At the end it prints a credential table — one row per role — so every
 * developer / tester immediately knows what to use.
 *
 * Usage:
 *   npm run seed                    # uses .env
 *   DB_HOST=... npm run seed        # env override
 *
 * ⚠  NEVER run against a live production database.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../data-source';
import { seedRolesPermissions } from './seed-roles-permissions';
import {
  STANDARD_ACCOUNT_GROUPS,
  STANDARD_ACCOUNTS,
} from '../../modules/master-data/chart-of-accounts/application/construction-coa.seed';

dotenv.config();

// ── Configuration ─────────────────────────────────────────────────────────────

const COMPANY_NAME = 'Zakir Enterprise';
const COMPANY_LEGAL = 'Zakir Enterprise Ltd';
const COMPANY_BIN = '4057650345321';
const COMPANY_TIN = '654321987012';

const FY_LABEL = 'FY 2025-26';
const FY_START = '2025-07-01';
const FY_END = '2026-06-30';

const SEED_PASSWORD = 'ZE@dev2025!';
const BCRYPT_ROUNDS = 10;

interface UserSeed {
  role: string;
  name: string;
  email: string;
}

const USER_SEEDS: UserSeed[] = [
  { role: 'ADMIN',           name: 'Admin User',           email: 'admin@ze.local' },
  { role: 'ACCOUNTS_TEAM',   name: 'Accounts Officer',     email: 'accounts@ze.local' },
  { role: 'PROJECT_MANAGER', name: 'Project Manager',      email: 'pm@ze.local' },
  { role: 'SITE_ENGINEER',   name: 'Site Engineer',        email: 'engineer@ze.local' },
  { role: 'STORE_KEEPER',    name: 'Store Keeper',         email: 'storekeeper@ze.local' },
  { role: 'HR_MANAGER',      name: 'HR Manager',           email: 'hr@ze.local' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(`  ${msg}\n`);
}

function banner(msg: string): void {
  process.stdout.write(`\n${'═'.repeat(60)}\n  ${msg}\n${'═'.repeat(60)}\n`);
}

function divider(): void {
  process.stdout.write(`  ${'─'.repeat(58)}\n`);
}

// ── Seed functions ────────────────────────────────────────────────────────────

async function ensureCompany(ds: DataSource): Promise<string> {
  const rows = await ds.query(
    `SELECT id FROM "company" WHERE name = $1 LIMIT 1`,
    [COMPANY_NAME],
  );
  if (rows.length > 0) {
    log(`Company already exists  → ${rows[0].id}`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "company" (id, name, legal_name, bin, tin, is_active, version)
     VALUES ($1, $2, $3, $4, $5, true, 1)`,
    [id, COMPANY_NAME, COMPANY_LEGAL, COMPANY_BIN, COMPANY_TIN],
  );
  log(`Company created         → ${id}`);
  return id;
}

async function ensureFinancialYear(ds: DataSource, companyId: string): Promise<string> {
  const rows = await ds.query(
    `SELECT id FROM "financial_year" WHERE company_id = $1 AND label = $2 LIMIT 1`,
    [companyId, FY_LABEL],
  );
  if (rows.length > 0) {
    log(`Financial year exists   → ${rows[0].id}`);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await ds.query(
    `INSERT INTO "financial_year" (id, company_id, label, start_date, end_date, is_active, version)
     VALUES ($1, $2, $3, $4, $5, true, 1)`,
    [id, companyId, FY_LABEL, FY_START, FY_END],
  );
  log(`Financial year created  → ${id}`);
  return id;
}

async function seedCoA(ds: DataSource, companyId: string): Promise<void> {
  // Account groups — resolve parent names to IDs as we insert
  const nameToId = new Map<string, string>();

  // Load existing groups for idempotency
  const existing = await ds.query(
    `SELECT id, name FROM "account_group" WHERE company_id = $1`,
    [companyId],
  );
  for (const r of existing) nameToId.set(r.name, r.id);

  let inserted = 0;
  for (const g of STANDARD_ACCOUNT_GROUPS) {
    if (nameToId.has(g.name)) continue;
    const id = crypto.randomUUID();
    const parentId = g.parent ? (nameToId.get(g.parent) ?? null) : null;
    await ds.query(
      `INSERT INTO "account_group" (id, company_id, name, parent_group_id, type, version)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [id, companyId, g.name, parentId, g.type],
    );
    nameToId.set(g.name, id);
    inserted++;
  }

  // Accounts
  const existingCodes = new Set<string>(
    (await ds.query(`SELECT code FROM "account" WHERE company_id = $1`, [companyId])).map((r: { code: string }) => r.code),
  );

  let acInserted = 0;
  for (const a of STANDARD_ACCOUNTS) {
    if (existingCodes.has(a.code)) continue;
    const groupId = nameToId.get(a.group);
    if (!groupId) continue;
    await ds.query(
      `INSERT INTO "account" (id, company_id, account_group_id, code, name, type, is_active, version)
       VALUES ($1, $2, $3, $4, $5, $6, true, 1)`,
      [crypto.randomUUID(), companyId, groupId, a.code, a.name, a.type],
    );
    acInserted++;
  }

  if (inserted > 0 || acInserted > 0) {
    log(`CoA seeded              → ${inserted} groups, ${acInserted} accounts`);
  } else {
    log(`CoA already seeded      → skipped`);
  }
}

async function seedUsers(
  ds: DataSource,
  companyId: string,
  financialYearId: string,
  passwordHash: string,
): Promise<void> {
  let inserted = 0;
  for (const u of USER_SEEDS) {
    const existing = await ds.query(
      `SELECT id FROM "user" WHERE company_id = $1 AND email = $2 LIMIT 1`,
      [companyId, u.email],
    );
    if (existing.length > 0) continue;
    await ds.query(
      `INSERT INTO "user"
         (id, company_id, financial_year_id, email, password_hash, name, role, is_active, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, 1)`,
      [crypto.randomUUID(), companyId, financialYearId, u.email, passwordHash, u.name, u.role],
    );
    inserted++;
  }
  if (inserted > 0) {
    log(`Users created           → ${inserted} of ${USER_SEEDS.length}`);
  } else {
    log(`Users already exist     → skipped`);
  }
}

// ── Credential table ──────────────────────────────────────────────────────────

function printCredentials(companyId: string): void {
  banner('ZE-ERP DEV SEED — login credentials');

  const pad = (s: string, n: number) => s.padEnd(n);

  log(`Company ID  : ${companyId}`);
  log(`Fin Year    : ${FY_LABEL}  (${FY_START} → ${FY_END})`);
  log('');
  log(`${pad('Role', 20)}  ${pad('Email', 26)}  Password`);
  divider();
  for (const u of USER_SEEDS) {
    log(`${pad(u.role, 20)}  ${pad(u.email, 26)}  ${SEED_PASSWORD}`);
  }
  divider();
  log('⚠  These are TEMPORARY DEV credentials. Never use in production.');
  banner('Seed complete');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner('ZE-ERP — running dev seed');

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

  log('Running pending migrations…');
  const ran = await ds.runMigrations({ transaction: 'each' });
  if (ran.length > 0) {
    log(`Migrations ran          → ${ran.map(m => m.name).join(', ')}`);
  } else {
    log('Migrations              → already up to date');
  }

  const companyId = await ensureCompany(ds);
  const financialYearId = await ensureFinancialYear(ds, companyId);

  await seedCoA(ds, companyId);
  await seedRolesPermissions(ds, companyId);
  log('Roles & permissions     → seeded');

  log('Hashing seed password (bcrypt)…');
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);
  await seedUsers(ds, companyId, financialYearId, passwordHash);

  await ds.destroy();

  printCredentials(companyId);
}

main().catch((err: unknown) => {
  process.stderr.write(`\nSeed failed: ${String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
