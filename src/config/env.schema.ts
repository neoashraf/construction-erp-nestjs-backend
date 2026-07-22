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
