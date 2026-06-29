/**
 * DatabaseHealthIndicator (skill §11, ADR-0002 §2.3 Observability) — a terminus indicator that
 * pings PostgreSQL via the app's own `DATA_SOURCE` (`SELECT 1`). Avoids pulling in @nestjs/typeorm
 * just for a health check.
 */
import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../database/database.module';

@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {
    super();
  }

  async pingCheck(key = 'database'): Promise<HealthIndicatorResult> {
    try {
      await this.dataSource.query('SELECT 1');
      return this.getStatus(key, true);
    } catch (error) {
      throw new HealthCheckError(
        'Database ping failed',
        this.getStatus(key, false, {
          message: error instanceof Error ? error.message : 'unknown error',
        }),
      );
    }
  }
}
