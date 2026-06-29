/**
 * UnitOfWork integration (skill §2.4, ADR-0002 §2.1 Transactions) — Testcontainers Postgres.
 * Proves `UnitOfWork.run(work)` is ONE transaction: commit on success, rollback on throw, and that
 * code inside `run` enrols in the active transaction via AsyncLocalStorage (`getManager`).
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import {
  getActiveManager,
  getManager,
} from '../src/infrastructure/unit-of-work/transaction-context';

jest.setTimeout(120_000);

describe('TypeOrmUnitOfWork (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let uow: TypeOrmUnitOfWork;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE TABLE scratch (id INT PRIMARY KEY, val TEXT NOT NULL)');
    uow = new TypeOrmUnitOfWork(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await dataSource.query('TRUNCATE scratch');
  });

  it('commits all work in a single transaction on success', async () => {
    await uow.run(async () => {
      const m = getManager(dataSource);
      await m.query("INSERT INTO scratch (id, val) VALUES (1, 'a')");
      await m.query("INSERT INTO scratch (id, val) VALUES (2, 'b')");
    });
    const rows = await dataSource.query('SELECT id FROM scratch ORDER BY id');
    expect(rows.map((r: { id: number }) => r.id)).toEqual([1, 2]);
  });

  it('rolls the whole transaction back when work throws', async () => {
    await expect(
      uow.run(async () => {
        await getManager(dataSource).query("INSERT INTO scratch (id, val) VALUES (3, 'c')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const rows = await dataSource.query('SELECT id FROM scratch');
    expect(rows).toHaveLength(0); // the insert was rolled back atomically
  });

  it('binds an active transactional manager inside run() and clears it outside', async () => {
    expect(getActiveManager()).toBeUndefined();

    await uow.run(async () => {
      const active = getActiveManager();
      expect(active).toBeDefined();
      // getManager() returns the SAME active manager — i.e. repositories enrol in this tx.
      expect(getManager(dataSource)).toBe(active);
      await active!.query("INSERT INTO scratch (id, val) VALUES (4, 'd')");
    });

    expect(getActiveManager()).toBeUndefined();
    const rows = await dataSource.query('SELECT id FROM scratch WHERE id = 4');
    expect(rows).toHaveLength(1);
  });
});
