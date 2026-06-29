/**
 * Application composition root (ADR-0002 §2.1). Wires the cross-cutting platform — config, logging,
 * database, infrastructure ports, health, the global error-envelope filter — and the empty-but-wired
 * `core/` kernel. Feature modules (`modules/*`) are added by their briefs. No business logic here.
 */
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { AppLoggerModule } from './infrastructure/logging/logger.module';
import { DatabaseModule } from './database/database.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { AllExceptionsFilter } from './infrastructure/http/all-exceptions.filter';
import { DiagnosticsModule } from './infrastructure/http/diagnostics.module';
import { HealthModule } from './health/health.module';
import { CoreModule } from './core/core.module';

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    DatabaseModule,
    InfrastructureModule,
    HealthModule,
    CoreModule,
    // Diagnostic throw-routes for the e2e error-envelope smoke — never in production.
    DiagnosticsModule.register(process.env.NODE_ENV !== 'production'),
  ],
  providers: [
    // Global error-envelope filter (overview §6) for every route.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
