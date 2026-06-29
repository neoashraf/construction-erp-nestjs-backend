import { envValidationSchema } from '../../src/config/env.schema';

const baseEnv = {
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USERNAME: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_NAME: 'ze_erp',
  JWT_SECRET: 'a-sufficiently-long-secret',
};

describe('env validation schema (fail-fast)', () => {
  it('accepts a complete, valid environment and applies defaults', () => {
    const { error, value } = envValidationSchema.validate(baseEnv, { abortEarly: false });
    expect(error).toBeUndefined();
    expect(value.NODE_ENV).toBe('development');
    expect(value.PORT).toBe(3000);
    expect(value.DB_POOL_MAX).toBe(20);
  });

  it('fails when a required var (DB_HOST) is missing', () => {
    const { DB_HOST: _omit, ...withoutHost } = baseEnv;
    const { error } = envValidationSchema.validate(withoutHost, { abortEarly: false });
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/DB_HOST/);
  });

  it('fails when JWT_SECRET is too short', () => {
    const { error } = envValidationSchema.validate(
      { ...baseEnv, JWT_SECRET: 'short' },
      { abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/JWT_SECRET/);
  });

  it('reports ALL invalid vars at once (abortEarly:false)', () => {
    const { error } = envValidationSchema.validate(
      { DB_USERNAME: 'x', DB_PASSWORD: 'y', DB_NAME: 'z', JWT_SECRET: 'a-sufficiently-long-secret' },
      { abortEarly: false },
    );
    // both DB_HOST and DB_PORT are missing — surfaced together, not one-at-a-time
    expect(error?.details.length).toBeGreaterThanOrEqual(2);
  });
});
