/**
 * Typed config accessors. A thin, strongly-typed view over the validated env (env.schema.ts),
 * registered with @nestjs/config so the rest of the app never reads `process.env` directly.
 */
import { ConfigService } from '@nestjs/config';
import { registerAs } from '@nestjs/config';

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssl: boolean;
  poolMax: number;
}

export interface JwtConfig {
  secret: string;
  accessTtl: string;
  refreshTtl: string;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
}

export const appConfig = registerAs(
  'app',
  (): AppConfig => ({
    nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
    port: parseInt(process.env.PORT ?? '3000', 10),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  }),
);

export const databaseConfig = registerAs(
  'database',
  (): DatabaseConfig => ({
    host: process.env.DB_HOST as string,
    port: parseInt(process.env.DB_PORT as string, 10),
    username: process.env.DB_USERNAME as string,
    password: process.env.DB_PASSWORD as string,
    database: process.env.DB_NAME as string,
    ssl: process.env.DB_SSL === 'true',
    poolMax: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
  }),
);

export const jwtConfig = registerAs(
  'jwt',
  (): JwtConfig => ({
    secret: process.env.JWT_SECRET as string,
    accessTtl: process.env.JWT_ACCESS_TTL ?? '900s',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
  }),
);

/** Convenience typed getters over ConfigService. */
export const getDatabaseConfig = (config: ConfigService): DatabaseConfig =>
  config.getOrThrow<DatabaseConfig>('database');
export const getAppConfig = (config: ConfigService): AppConfig =>
  config.getOrThrow<AppConfig>('app');
export const getJwtConfig = (config: ConfigService): JwtConfig =>
  config.getOrThrow<JwtConfig>('jwt');
