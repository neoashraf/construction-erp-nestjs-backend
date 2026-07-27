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

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Top-level folder every asset is namespaced under (e.g. `zakir-erp/companies/<id>/avatars`). */
  rootFolder: string;
}

/** Biometric attendance device — pull-sync target and push auto-registration tenant. */
export interface DeviceConfig {
  /** LAN address of the fingerprint device. Empty ⇒ pull-sync unavailable. */
  ip: string;
  port: number;
  /** Port the device pushes from (ZK "in" port); reserved for real-time log subscription. */
  inPort: number;
  timeoutMs: number;
  /** Company an unregistered serial auto-registers under. Empty ⇒ drop unknown serials. */
  defaultCompanyId: string;
}

export const deviceConfig = registerAs(
  'device',
  (): DeviceConfig => ({
    ip: process.env.DEVICE_IP ?? '',
    port: parseInt(process.env.DEVICE_PORT ?? '4370', 10),
    inPort: parseInt(process.env.DEVICE_IN_PORT ?? '5200', 10),
    timeoutMs: parseInt(process.env.DEVICE_TIMEOUT_MS ?? '10000', 10),
    defaultCompanyId: process.env.DEVICE_DEFAULT_COMPANY_ID ?? '',
  }),
);

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

export const cloudinaryConfig = registerAs(
  'cloudinary',
  (): CloudinaryConfig => ({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
    rootFolder: process.env.CLOUDINARY_ROOT_FOLDER ?? 'zakir-erp',
  }),
);

/** Convenience typed getters over ConfigService. */
export const getDatabaseConfig = (config: ConfigService): DatabaseConfig =>
  config.getOrThrow<DatabaseConfig>('database');
export const getAppConfig = (config: ConfigService): AppConfig =>
  config.getOrThrow<AppConfig>('app');
export const getJwtConfig = (config: ConfigService): JwtConfig =>
  config.getOrThrow<JwtConfig>('jwt');
export const getDeviceConfig = (config: ConfigService): DeviceConfig =>
  config.getOrThrow<DeviceConfig>('device');
