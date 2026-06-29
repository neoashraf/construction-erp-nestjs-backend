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
})
  // Reject unknown keys would be too strict (CI injects extras); allow but don't expose them.
  .unknown(true);
