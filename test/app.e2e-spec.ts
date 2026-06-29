/**
 * Smoke e2e (brief DoD, skill §13) — Testcontainers Postgres + the REAL AppModule.
 * Asserts: the app boots and connects to PG; `GET /api/health` reports the database up; and the
 * global error envelope (overview §6) is emitted for a thrown domain error and an unhandled error.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';

jest.setTimeout(120_000);

describe('App smoke (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();

    // Point the real config at the container BEFORE the module compiles (Joi validates here).
    process.env.NODE_ENV = 'test';
    process.env.DB_HOST = container.getHost();
    process.env.DB_PORT = String(container.getPort());
    process.env.DB_USERNAME = container.getUsername();
    process.env.DB_PASSWORD = container.getPassword();
    process.env.DB_NAME = container.getDatabase();
    process.env.JWT_SECRET = 'test-secret-at-least-16-chars';

    // Imported lazily so the env above is in place before ConfigModule initializes.
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (container) await container.stop();
  });

  it('GET /api/health → 200 with database indicator up', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
  });

  it('GET /api/_diag/domain-error → 400 with the error envelope (VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer()).get('/api/_diag/domain-error').expect(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'deliberate domain error for smoke test',
        details: { field: 'demo' },
      },
    });
  });

  it('GET /api/_diag/unhandled → 500 with a redacted INTERNAL_ERROR envelope', async () => {
    const res = await request(app.getHttpServer()).get('/api/_diag/unhandled').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('An unexpected error occurred.');
    // internals must NOT leak
    expect(JSON.stringify(res.body)).not.toContain('deliberate unhandled error');
  });

  it('GET /api/unknown-route → 404 in the error envelope', async () => {
    const res = await request(app.getHttpServer()).get('/api/unknown-route').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/_diag/echo rejects an unknown extra field (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/_diag/echo')
      .send({ name: 'x', count: 1, surprise: 'extra' })
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(res.body)).toMatch(/surprise/);
  });

  it('POST /api/_diag/echo accepts a valid DTO and returns the transformed instance', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/_diag/echo')
      .send({ name: 'x', count: 5 })
      .expect(200);
    expect(res.body).toEqual({ name: 'x', count: 5, countType: 'number' });
  });

  it('POST /api/_diag/echo rejects a wrong-typed field (count not an int)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/_diag/echo')
      .send({ name: 'x', count: 'not-a-number' })
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});
