/**
 * TypeOrmUnitOfWork (skill §2.4, ADR-0002 §2.1) — the infra adapter implementing the `UnitOfWork`
 * port. `run(work)` opens ONE `dataSource.transaction`, binds its EntityManager into the
 * AsyncLocalStorage context, and runs `work` inside it: a thrown error rolls the whole thing back,
 * success commits. Repositories created inside transparently enrol via `getManager()`.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UnitOfWork } from '../../common/ports/unit-of-work.port';
import { runWithManager } from './transaction-context';

@Injectable()
export class TypeOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.dataSource.transaction((manager) => runWithManager(manager, work));
  }
}
