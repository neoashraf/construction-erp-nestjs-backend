/**
 * TransactionContext (skill §2.4) — INFRASTRUCTURE.
 *
 * An `AsyncLocalStorage` slot holding the EntityManager of the transaction currently open via the
 * UnitOfWork. Repositories call `getManager(dataSource)` to obtain the right manager WITHOUT being
 * handed it explicitly: inside `uow.run(...)` they enrol in the active transaction; outside one they
 * fall back to the DataSource's default (auto-commit) manager. This is what keeps the raw
 * `EntityManager` from leaking above `infrastructure/` while still giving atomic posts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { DataSource, EntityManager } from 'typeorm';

const storage = new AsyncLocalStorage<EntityManager>();

/** Run `work` with `manager` bound as the active transactional manager. */
export function runWithManager<T>(manager: EntityManager, work: () => Promise<T>): Promise<T> {
  return storage.run(manager, work);
}

/** The active transactional manager, if a UnitOfWork transaction is open. */
export function getActiveManager(): EntityManager | undefined {
  return storage.getStore();
}

/**
 * The manager a repository should use: the active transactional one if inside `uow.run`, otherwise
 * the DataSource's default manager (each statement auto-commits).
 */
export function getManager(dataSource: DataSource): EntityManager {
  return storage.getStore() ?? dataSource.manager;
}
