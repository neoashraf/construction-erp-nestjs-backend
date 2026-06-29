/**
 * TypeORM DataSource (ADR-0002 §2.3 Migrations, skill §11) — INFRASTRUCTURE.
 *
 * `synchronize:false` and `migrationsRun:false` ALWAYS — schema changes ship as explicit migrations,
 * never auto-sync. This module exports:
 *   - `buildDataSourceOptions(cfg)` — the single options builder shared by the app and the CLI;
 *   - a default `DataSource` for the TypeORM CLI (migration:generate/run/revert), env-driven.
 *
 * Entities are discovered by the `*.orm-entity.{ts,js}` convention; migrations by `migrations/*`.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { DatabaseConfig } from '../config/app-config';

export function buildDataSourceOptions(cfg: DatabaseConfig): DataSourceOptions {
  return {
    type: 'postgres',
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    // NON-NEGOTIABLE: never auto-create/alter schema; migrations are the only path.
    synchronize: false,
    migrationsRun: false,
    // Entities + migrations resolve under both ts-node (src) and compiled (dist).
    entities: [__dirname + '/../**/*.orm-entity.{ts,js}'],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    migrationsTableName: 'typeorm_migrations',
    extra: {
      // pool ceiling (ADR-0002 §2.3 — pool max 20)
      max: cfg.poolMax,
    },
  };
}

/** Read a DatabaseConfig straight from the environment — used only by the CLI entrypoint below. */
function databaseConfigFromEnv(): DatabaseConfig {
  dotenv.config();
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'ze_erp',
    ssl: process.env.DB_SSL === 'true',
    poolMax: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
  };
}

/** Default export consumed by the TypeORM CLI (`typeorm -d src/database/data-source.ts`). */
const dataSource = new DataSource(buildDataSourceOptions(databaseConfigFromEnv()));
export default dataSource;
