/**
 * Environment schema (ADR-0002 §2.3 Config, skill §11) — Joi, fail-fast.
 * Boot is aborted by @nestjs/config if any required var is missing/invalid; there is no partial boot.
 * No secrets in code; everything comes from the environment.
 */
import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  // PostgreSQL
  DB_HOST: Joi.string().hostname().required(),
  DB_PORT: Joi.number().port().required(),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').required(),
  DB_NAME: Joi.string().required(),
  DB_SSL: Joi.boolean().default(false),
  DB_POOL_MAX: Joi.number().integer().min(1).max(100).default(20),

  // JWT — consumed by the auth-jwt brief; validated here so the schema is stable.
  JWT_SECRET: Joi.string().min(16).required(),
  JWT_ACCESS_TTL: Joi.string().default('900s'),
  JWT_REFRESH_TTL: Joi.string().default('7d'),

  // Biometric attendance device — pull-sync (`POST /api/sync`) and push auto-registration.
  //
  // All OPTIONAL so the app boots without a device attached. `DEVICE_IP` empty ⇒ pull-sync is
  // unavailable and `POST /api/sync` falls back to re-reconciling stored punches; push
  // ingestion is unaffected either way, since the device dials in on its own.
  //
  // NOTE: pull-sync opens a socket to the device on the LAN, so the server must reach
  // `DEVICE_IP` directly — it cannot traverse NAT. A cloud-hosted backend can only use push.
  DEVICE_IP: Joi.string().allow('').optional(),
  DEVICE_PORT: Joi.number().port().default(4370),
  DEVICE_IN_PORT: Joi.number().port().default(5200),
  DEVICE_TIMEOUT_MS: Joi.number().integer().min(1000).max(120000).default(10000),
  /**
   * Company that punches from an UNREGISTERED device serial are attributed to.
   *
   * Without this, an unknown serial has its punches dropped (the safe default — guessing a
   * company would be a cross-tenant leak). Setting it explicitly opts into auto-registration:
   * a first-contact serial creates its own `attendance_device` row against THIS company, so
   * real attendance is never silently lost while a device is being commissioned.
   */
  DEVICE_DEFAULT_COMPANY_ID: Joi.string().uuid().allow('').optional(),

  // Cloudinary — profile-avatar image store (AUD profile slice, FR-AUD-038..043).
  // OPTIONAL so the app boots in dev/test/CI without it; the MediaStorage adapter fails at
  // call time (MEDIA_STORAGE_ERROR) if an avatar upload is attempted while unconfigured.
  CLOUDINARY_CLOUD_NAME: Joi.string().allow('').optional(),
  CLOUDINARY_API_KEY: Joi.string().allow('').optional(),
  CLOUDINARY_API_SECRET: Joi.string().allow('').optional(),
  // Top-level Cloudinary folder every asset is namespaced under; defaults to `zakir-erp`.
  CLOUDINARY_ROOT_FOLDER: Joi.string().allow('').optional(),
})
  // Reject unknown keys would be too strict (CI injects extras); allow but don't expose them.
  .unknown(true);
