/**
 * Health endpoint (skill §11) — `GET /api/health` returns 200 with a `database` indicator up when
 * PostgreSQL is reachable, 503 otherwise. Used by liveness/readiness probes.
 */
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './database-health.indicator';
import { NoEnvelope } from '../infrastructure/http/no-envelope.decorator';

@ApiTags('health')
@Controller('health')
@NoEnvelope() // probes expect the Terminus shape — keep it out of the { data, meta } envelope.
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DatabaseHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.db.pingCheck('database')]);
  }
}
