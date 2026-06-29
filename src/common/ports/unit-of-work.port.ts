/**
 * UnitOfWork port (skill §2.4, ADR-0002 §2.1 Transactions, ADR-0001 #5).
 *
 * The application opens `uow.run(work)`; every repository created inside `work` transparently
 * enrols in the SAME database transaction (the infra adapter implements this with
 * `dataSource.transaction` + AsyncLocalStorage). On success the transaction commits; on a thrown
 * error it rolls back. The raw TypeORM `EntityManager` never appears above `infrastructure/`.
 */
export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** DI token for the UnitOfWork port (the domain/application depend on the interface, not the impl). */
export const UNIT_OF_WORK = Symbol('UnitOfWork');
