# ze-erp-nestjs-backend

Backend for **Zakir Enterprise — Construction ERP**: a NestJS modular monolith on PostgreSQL,
built to the Clean/Hexagonal standard in [ADR-0002](../../docs/decisions/0002-backend-architecture.md)
and the non-negotiables in [ADR-0001](../../docs/decisions/0001-architecture-baseline.md) / `CLAUDE.md`.

> This repo currently contains the **scaffold only** (brief `backend-scaffold`): an empty-but-correct
> chassis. No business logic ships yet — feature briefs (MAS, LED, NUM, PER, AUD, …) fill it in.

## Architecture (the dependency rule)

Inward-only dependencies: `domain ← application ← infrastructure / presentation`.

```
src/
  common/          pure-TypeScript domain primitives — Entity/AggregateRoot/ValueObject,
                   Money (decimal.js), Result, value objects (Tin/Bin/PhoneNumber/DateOnly),
                   ports (UnitOfWork/Clock/IdGenerator/…), DomainError + codes.   NO NestJS, NO TypeORM.
  config/          typed @nestjs/config module + Joi env schema (fail-fast).
  database/        TypeORM DataSource (synchronize:false), migrations/, seeds/,
                   persistence/ decimal transformers (numeric(18,4)/(18,3) ↔ Decimal).
  infrastructure/  cross-cutting adapters — UnitOfWork (AsyncLocalStorage), pino logging
                   + correlation id, the global error-envelope exception filter.
  health/          @nestjs/terminus /health with a DB ping.
  core/            shared kernel — empty-but-wired modules: posting, numbering, period,
                   audit, auth, tenancy (each domain/application/infrastructure/presentation).
  modules/         feature modules (empty; populated by feature briefs).
```

The `domain` layer (`src/common/**`, `src/**/domain/**`) imports neither NestJS nor TypeORM —
enforced by an ESLint `no-restricted-imports` rule (`.eslintrc.js`) and `npm run lint`.

## Prerequisites

- Node.js ≥ 20, npm ≥ 10
- PostgreSQL ≥ 15 (local or Docker) for `start:dev`, migrations, and DB-backed tests
- Docker (for the Testcontainers e2e/integration suite)

## Getting started

```bash
npm install
cp .env.example .env          # then edit DB_* etc.
npm run start:dev             # boots on http://localhost:3000 ; GET /api/health
```

OpenAPI/Swagger is served at `/api/docs`.

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | watch-mode dev server |
| `npm run build` | `nest build` (tsc, `tsconfig.build.json`) |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint incl. the dependency-rule check |
| `npm test` | unit tests (no DB/Docker) — the merge gate |
| `npm run test:e2e` | e2e + integration (Testcontainers Postgres) |
| `npm run migration:run` / `:revert` / `:generate` | TypeORM migration tooling |

## Money

All money/quantity arithmetic uses **decimal.js**, never JS floats. Columns are `numeric(18,4)`
(money) / `numeric(18,3)` (quantity); the `moneyTransformer`/`qtyTransformer` map them to `Decimal`
on read and back to fixed-scale strings on write. See `src/common/money.ts`.

## Transactions

The application opens `UnitOfWork.run(work)`; repositories created inside transparently enrol in the
active transaction via `AsyncLocalStorage`. `EntityManager` never appears above `infrastructure/`.
