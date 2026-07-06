/**
 * DashboardModule (DSH) — composition root for the read-only dashboard layer. DSH owns NO entity, NO
 * migration, and NEVER calls `PostingService`. It REUSES RPT's read definitions to guarantee single
 * source of truth (FR-DSH-004): it imports `ReportsModule` (which now EXPORTS its four read-port tokens —
 * COST_CONTROL / SALES / INVENTORY / HR) and injects those adapters directly, so a tile and the RPT report
 * it drills into read ONE definition. For the two ledger-sourced tiles (cash-flow summary + AR/AP-by-party
 * top-N) — reads RPT does not expose — DSH binds its own `DASHBOARD_LEDGER_READ_PORT` to a ledger adapter
 * running the SAME canonical scoped SQL over `journal_line`/`journal_entry` (one ledger definition; the
 * cash-flow tile still drills into RPT's `cash-bank-book`, same source).
 *
 * `ReportScopeService` is provided locally (stateless, no deps) and reused by `DashboardScopeService` for
 * the F3/F4 project boundary. `AuthModule` supplies JwtAuthGuard/RolesGuard behind
 * `@Roles({ module:'DSH', action:'READ' })`.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../../core/auth/auth.module';
import { ReportsModule } from '../../reports/presentation/reports.module';
import { ReportScopeService } from '../../reports/application/report-scope.service';
import { DashboardService } from '../application/dashboard.service';
import { DashboardScopeService } from '../application/dashboard-scope.service';
import { TileQueryService } from '../application/tile-query.service';
import { DASHBOARD_LEDGER_READ_PORT } from '../domain/ports/ledger.read.port';
import { LedgerReadAdapter } from '../infrastructure/ledger.read.adapter';
import { DashboardController } from './dashboard.controller';

@Module({
  imports: [AuthModule, ReportsModule],
  controllers: [DashboardController],
  providers: [
    DashboardService,
    TileQueryService,
    DashboardScopeService,
    ReportScopeService,
    { provide: DASHBOARD_LEDGER_READ_PORT, useClass: LedgerReadAdapter },
  ],
})
export class DashboardModule {}
