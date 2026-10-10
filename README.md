# Construction ERP (Backend)

REST API and Socket.IO server for a project-centric construction ERP built for
a Bangladeshi construction group. Accounting, project management, inventory,
purchasing, IPC billing, receipts, payments and HR all post to one general
ledger, so project P&L and job costing are queries over that ledger rather than
separate subsystems.

The web client is the sibling repo `construction-erp-nextjs-frontend`. Browsers
never call this API directly: the frontend's Next.js BFF holds the JWTs in
httpOnly cookies and forwards each request here with a bearer token.

## Stack

Versions are the ones locked in `package-lock.json`.

| Concern | Library |
|---|---|
| Framework | NestJS 10.4 on Node >= 20, TypeScript 5.9 |
| Database | PostgreSQL 15+, TypeORM 0.3 (`synchronize: false`, migrations only), `pg` 8 |
| Auth | `@nestjs/jwt` 11, passport-jwt 4, bcrypt 6 |
| Validation and config | class-validator, class-transformer, Joi 17 env schema |
| Money | decimal.js 10 |
| Realtime | Socket.IO 4.8 via `@nestjs/websockets` |
| Scheduling | `@nestjs/schedule` 4 |
| Logging | nestjs-pino 4 with a correlation id per request |
| API docs | `@nestjs/swagger` 7.4 |
| Exports | exceljs 4 (Excel), pdfkit 0.19 (PDF) |
| Attendance devices | node-zklib 1.3 (ZKTeco) |
| Media | Cloudinary 2 (profile avatars) |
| Tests | Jest 29, Supertest 7, Testcontainers 10 (PostgreSQL) |

## Modules

287 route handlers across these modules. Business controllers sit behind
`JwtAuthGuard` + `RolesGuard`, and resource controllers declare a permission
per route. The exceptions are the public auth routes (login, refresh),
`/health`, the non-production `/_diag` smoke routes, and the device-facing
`/iclock` routes described under HR.

**Shared kernel (`src/core/`)**

| Module | What it does | Routes |
|---|---|---|
| auth | Login, refresh (new access token; refresh tokens tracked by id and revoked on logout or password change), logout, change password, forced password change, users, roles, resource x action permissions, custom roles, per-user project scope, profile and avatar | `api/auth`, `api/users`, `api/roles`, `api/permissions`, `api/users/:id/projects`, `api/profile` |
| audit | Append-only audit log with filtered read and export | `api/audit-logs` |
| posting | `PostingService` and the ledger read side: journal entries, lines, account ledger, trial balance | `api/ledger` |
| numbering | Voucher numbering series per company, financial year and voucher type | `api/masters/numbering-series` |
| period | Accounting period generation, close and reopen; blocks posting into a closed period | `api/periods` |
| cost-control | Budget vs actual, project and cost-centre profitability, over-budget checks used at posting time | `api/cost-control` |
| notifications | In-app notifications: REST read/mark and a Socket.IO push gateway | `api/notifications`, `/ws/notifications` |
| tenancy | Company scoping helpers for the current actor (no routes) | none |

**Feature modules (`src/modules/`)**

| Module | What it does | Routes |
|---|---|---|
| master-data | Companies, financial years, account groups and chart of accounts, cost centres, godowns, items with UoM conversions, parties, projects, project budgets, purposes | `api/masters/*` |
| inventory | Stock journals (draft, post, reverse), append-only stock movements, stock balances, stock ledger | `api/stock-journal` |
| purchase | Purchase orders, purchase bills (post, cancel, repost) and GRNs with PO/bill matching | `api/purchase/bills` |
| requisition | Site requisitions: submit, approve or escalate, issue from godown with consumption posting, reverse issue | `api/requisition` |
| sales | IPC billing with retention and mobilization-advance recovery, cancel, repost, retention release | `api/sales/ipc` |
| receipt | IPC-linked and general customer receipts with per-IPC outstanding | `api/receipt` |
| payment | Payments against purchase bills, labour payables and salary, with allocation, cancel and repost | `api/payment` |
| contra-journal | Contra and journal vouchers, reversal, and the one-time opening journal | `api/contra`, `api/journal` |
| hr | Employees, attendance, attendance devices and reports, holidays, salary sheets and payslips | see HR below |

**Read side**

| Module | What it does | Routes |
|---|---|---|
| reports | Report catalogue with financial statements, ledgers, project / IPC, requisition cost control, inventory and HR reports; JSON, Excel and PDF export | `api/reports` |
| dashboard | Role-scoped KPI tiles | `api/dashboard` |
| health | Liveness and readiness with a DB ping | `/health`, `/health/live`, `/health/ready` |

## The ledger and its database guards

The ledger is two tables, `journal_entry` and `journal_line`. Each line
carries an account plus project, cost centre, purpose, godown and party
columns. The tag matrix (`src/core/posting/domain/tag-matrix.ts`) decides
which are required: income and expense lines need project, cost centre and
purpose; control-account lines need a party; inventory lines need a godown.

- **One writer.** `PostingService`
  (`src/core/posting/application/posting.service.ts`) is the only code that
  inserts ledger rows. Every voucher module builds a posting command and calls
  `post`, `reverse` or `repost` inside its own transaction. Checks run in this
  order: period open, project not closed, tag matrix, reference validity, line
  and balance invariants, and only then number allocation, so a rejected post
  consumes no number.
- **Append-only.** A PL/pgSQL function `ze_ledger_append_only()` fires
  `BEFORE UPDATE OR DELETE` on both ledger tables and raises an exception.
  Corrections are reverse-and-repost. The same pattern guards `audit_log` and
  `stock_movement`. (`src/database/migrations/1700000400000-CreateLedger.ts`,
  `1700000800000-CreateRbacAndAudit.ts`,
  `1700001000000-CreateStockMovementAndBalance.ts`)
- **Balanced at commit.** `trg_journal_line_balance` is a constraint trigger,
  `DEFERRABLE INITIALLY DEFERRED`, on insert into `journal_line`. At commit it
  rejects any entry whose total debit differs from its total credit. Row
  checks also require non-negative amounts and exactly one of debit or credit
  per line. (`1700000400000-CreateLedger.ts`)
- **Gapless numbering.** `TypeOrmNumberingService`
  (`src/core/numbering/infrastructure/typeorm-numbering.service.ts`) locks the
  series row with `SELECT ... FOR UPDATE`, increments it inside the caller's
  transaction and formats `<prefix>/<FY>/<sequence>`. A missing series is
  created inside `SAVEPOINT num_provision` so a concurrent first post cannot
  abort the outer transaction. It never opens its own transaction, so a
  rolled-back post leaves no gap.
- **Atomic.** A voucher's own rows, its journal entry and the number counter
  commit together or not at all.

## HR and payroll

- **Attendance modes.** `OFFICE`, `SUBCONTRACTOR` and `DAILY_LABOUR`
  (`src/modules/hr/domain/attendance-record.ts`). Confirming a daily-labour
  head count posts the labour cost as an accrual (labour cost against labour
  payable); the payment later settles that payable.
- **ZKTeco fingerprint devices.** Three ways in, deduplicated on user and
  device timestamp:
  - Push: the device posts raw text to `/iclock/cdata`. This route is
    unauthenticated because devices cannot send a JWT; the company is taken
    from the device serial registered in `attendance_device`, and punches from
    an unknown serial are dropped. Keep it on the site LAN or VPN, or behind
    an IP allowlist.
  - Pull: the server reads the device over UDP 4370 with node-zklib, on
    `POST /api/sync` and every `DEVICE_SYNC_INTERVAL_MINUTES` when `DEVICE_IP`
    is set.
  - Import: `POST /api/attendance/import`.
- **Reports.** Daily, range and summary attendance reports with CSV export
  (UTF-8 with a byte order mark so Excel opens it), under
  `api/reports/daily`, `range` and `summary`, plus weekly and government
  holiday settings.
- **Salary sheets** (`api/salary/sheets`): generate for a period, edit lines
  and components while in draft, post, reverse, list payslips. Net pay is
  gross plus allowances minus TDS, employee PF, advance recovery and other
  deductions. Late arrivals carry a penalty.
- **Pre-post warnings.** Generating a sheet returns, and stores on the sheet,
  the days with no attendance records, employees left off and why,
  per-employee unpaid days, and whether no weekly holiday is configured. They
  are advisory: posting does not require them to be cleared.
- **The SALARY journal entry**
  (`src/modules/hr/domain/salary-command.factory.ts`): debit Gross Salary and
  Wages and Employer PF Contribution; credit Salary Payable (net), TDS
  Payable, PF Payable (employer plus employee share) and Staff Advance
  Recovery. Every line carries project, the Labour cost centre and purpose.
- **Not implemented.** Overtime pay: hours are recorded but the amount is set
  to zero until the client confirms a rate (`salary.service.ts`). Payroll
  payables are posted per account in aggregate, without a party per employee.

## Notifications

- Socket.IO namespace `/ws/notifications`
  (`src/core/notifications/presentation/notifications.gateway.ts`).
- Handshake: the JWT access token in `auth.token` or an
  `Authorization: Bearer` header. An invalid token gets `connect_error` with
  `UNAUTHENTICATED`.
- Each socket joins the room `user:<companyId>:<userId>`.
- Server events: `connected` (with the unread count), `notification:new`,
  `notification:unreadCount`.
- 51 notification types, each routed to a role, to a role on the event's
  project, or to one user. Modules raise domain events on an in-process bus
  and the notification subscriber turns them into rows. A daily 1 AM job
  emits `IPC_OVERDUE` and `PERIOD_CLOSING_SOON`. `RETENTION_DUE` and
  `PAYABLE_OVERDUE` are in the catalogue but nothing emits them yet.
- Reads and mark-as-read go through `api/notifications`.

## Architecture

Modular monolith with Clean / Hexagonal layering, per ADR-0001 (architecture
baseline) and ADR-0002 (backend architecture) in the workspace repo
(`docs/decisions/`).

```
src/
  common/          pure TypeScript: Entity/AggregateRoot/ValueObject, Money,
                   Result, value objects, ports, DomainError codes
  config/          @nestjs/config + Joi env schema (fails fast at boot)
  database/        DataSource, migrations/, seeds/, decimal transformers
  infrastructure/  UnitOfWork, pino logging, error-envelope filter, event bus
  core/            shared kernel (see Modules)
  modules/         feature modules
  reports/ dashboard/ health/
```

- **Dependency rule.** Dependencies point inward only: `application`
  depends on `domain`, and `infrastructure` and `presentation` depend on
  `application`; never the reverse. Each module repeats `domain/`, `application/`,
  `infrastructure/`, `presentation/` and, where it has one, `read/` for query
  projections.
- **Lint check.** `.eslintrc.js` applies `no-restricted-imports` to
  `src/common/**` and every `src/**/domain/**`: those files may not import
  `@nestjs/*` or `typeorm`. `npm run lint` enforces it.
- **UnitOfWork.** Use cases call `UnitOfWork.run(work)`
  (`src/infrastructure/unit-of-work/`). Repositories pick up the active
  transaction through `AsyncLocalStorage`, so `EntityManager` never appears
  above `infrastructure/`.
- **HTTP conventions.** Business controllers declare their own `api/...`
  prefix. A global ValidationPipe whitelists and rejects unknown fields, and a
  global filter maps errors to the `{ error: { code, message, details } }`
  envelope. Master-data updates use optimistic locking on a version column.
- **Multi-company.** Every query is scoped by `company_id`, and vouchers by
  company and financial year.

## Money

All money and quantity arithmetic uses decimal.js (`src/common/money.ts`),
never JS floats. Columns are `numeric(18,4)` for money and `numeric(18,3)` for
quantity; transformers in `src/database/persistence/decimal.transformer.ts`
map them to `Decimal` on read and back to fixed-scale strings on write.

## Migrations and seeds

- 31 TypeORM migrations in `src/database/migrations/`. The Docker entrypoint
  applies them on container start; locally use `npm run migration:run`.
- `npm run seed` creates the base data: company, financial year, chart of
  accounts, the six built-in roles with their permissions, and one user per
  role with a temporary development password printed to the console. The
  seed is for development and staging databases.
- `npm run seed:all` also loads the demo data sets: workflow, module samples,
  purchase and inventory, reports, notifications.
- Swagger UI is served at `/api/v1/docs`.

## Testing

| Suite | Location | Files | Needs | Command |
|---|---|---|---|---|
| Unit | `test/unit/` | 105 | nothing | `npm test` |
| Integration | `test/*.int-spec.ts` | 47 | Docker (Testcontainers PostgreSQL) | `npm run test:e2e` |
| End-to-end | `test/app.e2e-spec.ts` | 1 | Docker | `npm run test:e2e` |

`npm run test:e2e` runs the integration and e2e files together, in band, with
a 120 s timeout per test. Run a single file with
`npm run test:e2e -- test/ledger-posting.int-spec.ts`. `npm run test:cov`
produces a coverage report; no coverage threshold is configured.

## CI/CD

`.github/workflows/deploy.yml` runs on pushes to `dev` and `main`:

1. `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` (unit tests
   only; the Testcontainers suites are not run in CI).
2. `dev` deploys to a self-hosted home server, `main` to a Hostinger VPS.
   Both copy a server-side `.env`, run `docker compose up -d --build`, wait
   for `/health`, then run `npm run seed:all`.

## Getting started

Prerequisites: Node >= 20, PostgreSQL 15+, and Docker for the integration
tests.

```bash
npm install
cp .env.example .env          # set DB_* and JWT_SECRET
npm run migration:run
npm run seed                  # base data and one login per role
npm run start:dev             # http://localhost:3000, health at /health
```

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | Watch-mode dev server |
| `npm run start:debug` | Dev server with the debugger |
| `npm run build` / `npm run start:prod` | Compile to `dist/` / run the build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the dependency-rule check |
| `npm run format` | Prettier over `src/` and `test/` |
| `npm test` | Unit tests |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:cov` | Unit tests with coverage |
| `npm run test:e2e` | Integration and e2e tests (Docker) |
| `npm run migration:run` / `migration:revert` | Apply / roll back migrations |
| `npm run migration:generate` / `migration:create` | New migration from entity diff / empty |
| `npm run seed` | Base seed |
| `npm run seed:all` | Base seed plus all demo data |

## Environment

Validated at boot by the Joi schema in `src/config/env.schema.ts`. See
`.env.example`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development`, `test` or `production` |
| `PORT` | no | `3000` | HTTP port |
| `LOG_LEVEL` | no | `info` | pino level |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` | yes | | PostgreSQL connection |
| `DB_SSL` | no | `false` | TLS to PostgreSQL |
| `DB_POOL_MAX` | no | `20` | Connection pool size |
| `JWT_SECRET` | yes | | Signing secret for access and refresh tokens |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | no | `900s` / `7d` | Token lifetimes |
| `DEVICE_IP` | no | | Attendance device address for pull; leave empty if unreachable |
| `DEVICE_PORT`, `DEVICE_IN_PORT`, `DEVICE_TIMEOUT_MS` | no | `4370`, `5200`, `10000` | Device connection |
| `DEVICE_SYNC_INTERVAL_MINUTES` | no | `3` | Minutes between automatic pulls; `0` disables |
| `DEVICE_DEFAULT_COMPANY_ID` | no | | Company for punches from unregistered device serials (push only) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_ROOT_FOLDER` | no | | Avatar storage; without them avatar upload returns 503 |

## Status

Phase 1 went live in August 2026 with the client's accounts team. All the
modules above are built. Overtime pay is not yet calculated, and the
`RETENTION_DUE` and `PAYABLE_OVERDUE` alerts are not yet emitted.
