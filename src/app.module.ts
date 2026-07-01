/**
 * Application composition root (ADR-0002 §2.1). Wires the cross-cutting platform — config, logging,
 * database, infrastructure ports, health, the global error-envelope filter — and the empty-but-wired
 * `core/` kernel. Feature modules (`modules/*`) are added by their briefs. No business logic here.
 */
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { AppLoggerModule } from './infrastructure/logging/logger.module';
import { DatabaseModule } from './database/database.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { AllExceptionsFilter } from './infrastructure/http/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './infrastructure/http/response-envelope.interceptor';
import { DiagnosticsModule } from './infrastructure/http/diagnostics.module';
import { HealthModule } from './health/health.module';
import { CoreModule } from './core/core.module';
import { MasterDataModule } from './modules/master-data/master-data.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ContraJournalModule } from './modules/contra-journal/presentation/contra-journal.module';

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    DatabaseModule,
    InfrastructureModule,
    HealthModule,
    CoreModule,
    // Feature modules (modules/*) — added by their briefs.
    MasterDataModule,
    InventoryModule,
    ContraJournalModule,
    // Diagnostic throw-routes for the e2e error-envelope smoke — never in production.
    DiagnosticsModule.register(process.env.NODE_ENV !== 'production'),
  ],
  providers: [
    // Central response model (overview §6): success → { data, meta }, error → { error, meta }.
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
