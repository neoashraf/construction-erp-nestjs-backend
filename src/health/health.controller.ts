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

  /**
   * Liveness — "is the process up?". Answers without touching the database ON PURPOSE: a liveness probe
   * that fails on a DB blip gets the container restarted, which does not fix a database. Readiness is
   * what should react to that.
   */
  @Get('live')
  live(): { status: 'live' } {
    return { status: 'live' };
  }

  /**
   * Readiness — "can this instance serve traffic?". Fails (503, via the Terminus check) while PostgreSQL
   * is unreachable, so the load balancer takes the instance out of rotation instead of routing requests
   * that are certain to fail.
   */
  @Get('ready')
  @HealthCheck()
  async ready(): Promise<{ status: 'ready' }> {
    await this.health.check([() => this.db.pingCheck('database')]);
    return { status: 'ready' };
  }
}
