/**
 * Infrastructure module — the composition root for cross-cutting driven-port adapters.
 * Binds the pure `UnitOfWork` / `Clock` / `IdGenerator` ports to their TypeORM/Node adapters and
 * exports them globally so every use case injects the interface, never the implementation
 * (ADR-0002 §2.1 ports & adapters).
 */
import { Global, Module, Provider } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CLOCK } from '../common/ports/clock.port';
import { ID_GENERATOR } from '../common/ports/id-generator.port';
import { UNIT_OF_WORK } from '../common/ports/unit-of-work.port';
import { DATA_SOURCE } from '../database/database.module';
import { SystemClock } from './system-clock';
import { UuidIdGenerator } from './uuid-id-generator';
import { TypeOrmUnitOfWork } from './unit-of-work/typeorm-unit-of-work';

const providers: Provider[] = [
  { provide: CLOCK, useClass: SystemClock },
  { provide: ID_GENERATOR, useClass: UuidIdGenerator },
  {
    provide: UNIT_OF_WORK,
    inject: [DATA_SOURCE],
    useFactory: (dataSource: DataSource) => new TypeOrmUnitOfWork(dataSource),
  },
];

@Global()
@Module({
  providers,
  exports: [CLOCK, ID_GENERATOR, UNIT_OF_WORK],
})
export class InfrastructureModule {}
