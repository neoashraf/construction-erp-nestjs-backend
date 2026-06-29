/**
 * Database module — provides the singleton TypeORM `DataSource` (INFRASTRUCTURE).
 * Built from validated config; initialized on boot; destroyed on shutdown.
 * Global so the UnitOfWork, repositories, and the health indicator can inject `DATA_SOURCE`.
 */
import { Global, Inject, Module, OnApplicationShutdown, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { getDatabaseConfig } from '../config/app-config';
import { buildDataSourceOptions } from './data-source';

/** DI token for the initialized DataSource. */
export const DATA_SOURCE = Symbol('DATA_SOURCE');

const dataSourceProvider: Provider = {
  provide: DATA_SOURCE,
  inject: [ConfigService],
  useFactory: async (config: ConfigService): Promise<DataSource> => {
    const dataSource = new DataSource(buildDataSourceOptions(getDatabaseConfig(config)));
    await dataSource.initialize();
    return dataSource;
  },
};

@Global()
@Module({
  providers: [dataSourceProvider],
  exports: [DATA_SOURCE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}
