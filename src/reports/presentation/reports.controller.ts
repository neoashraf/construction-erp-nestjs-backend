/**
 * ReportsController (RPT · PRESENTATION) — the READ-ONLY `/api/reports` surface. There is NO
 * POST/PUT/PATCH/DELETE of any kind here (FR-RPT-003): every route is a `GET` that runs one report's
 * canonical query over LED and returns the rows. Company is implicit from the JWT; a project-scoped user
 * (PM) is filtered server-side to assigned projects (F4) and `403`'d on an explicit unassigned `projectId`
 * (in ReportScopeService). Guards mirror LED/PUR: `@UseGuards(JwtAuthGuard, RolesGuard)` at class level +
 * `@Roles({ module:'RPT', action:'READ' })` on every route (FR-RPT-008; the brief's "reports:financial"
 * permission maps to RPT:READ). The actor is resolved via `@CurrentActor`.
 *
 * JSON is the only format wired in this brief (the JSON exporter); `format=excel|pdf` is rejected with a
 * clear `400` until the exporters land in RPT #30. Non-paginated reports (trial-balance, profit-and-loss,
 * balance-sheet) return a `ReportResult` (the interceptor wraps it in `data`); paginated reports
 * (account-ledger, daybook, cash-bank-book) return `Paginated` so the running balance / page info ride
 * `meta`.
 */
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ValidationError } from '../../common/errors/domain-error';
import { Actor } from '../../core/tenancy/tenant-context';
import { CurrentActor } from '../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/presentation/roles.guard';
import { Roles } from '../../core/auth/presentation/roles.decorator';
import { Paginated } from '../../infrastructure/http/pagination';
import { REPORT_CATALOG } from '../domain/report-catalog';
import { ReportDescriptor } from '../domain/report-descriptor';
import {
  AccountLedgerRow,
  BalanceSheetRow,
  ProjectPnlRow,
  ReportResult,
  TrialBalanceRow,
} from '../domain/report-result.model';
import { FileExporter, FILE_EXPORTER } from '../domain/ports/file-exporter.port';
import { ReportQueryService } from '../application/report-query.service';
import {
  AccountLedgerReportQueryDto,
  BalanceSheetReportQueryDto,
  CashBankBookReportQueryDto,
  DaybookReportQueryDto,
  ProfitAndLossReportQueryDto,
  TrialBalanceReportQueryDto,
} from './dto/reports-query.dto';

@ApiTags('Reports')
@Controller('api/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportsController {
  constructor(
    private readonly query: ReportQueryService,
    @Inject(FILE_EXPORTER) private readonly exporter: FileExporter,
  ) {}

  /** The report catalog (FR-RPT-001) — the authoritative list of runnable reports. */
  @Get()
  @Roles({ module: 'RPT', action: 'READ' })
  catalog(): ReportDescriptor[] {
    return REPORT_CATALOG;
  }

  @Get('trial-balance')
  @Roles({ module: 'RPT', action: 'READ' })
  async trialBalance(
    @Query() q: TrialBalanceReportQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<ReportResult<TrialBalanceRow>> {
    this.assertJson(q.format);
    return this.exporter.render(await this.query.trialBalance(q, actor)) as ReportResult<TrialBalanceRow>;
  }

  @Get('account-ledger')
  @Roles({ module: 'RPT', action: 'READ' })
  async accountLedger(
    @Query() q: AccountLedgerReportQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<AccountLedgerRow>> {
    this.assertJson(q.format);
    return this.query.accountLedger(q, actor);
  }

  @Get('daybook')
  @Roles({ module: 'RPT', action: 'READ' })
  async daybook(
    @Query() q: DaybookReportQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<AccountLedgerRow>> {
    this.assertJson(q.format);
    return this.query.daybook(q, actor);
  }

  @Get('cash-bank-book')
  @Roles({ module: 'RPT', action: 'READ' })
  async cashBankBook(
    @Query() q: CashBankBookReportQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<AccountLedgerRow>> {
    this.assertJson(q.format);
    return this.query.cashBankBook(q, actor);
  }

  @Get('profit-and-loss')
  @Roles({ module: 'RPT', action: 'READ' })
  async profitAndLoss(
    @Query() q: ProfitAndLossReportQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<ReportResult<ProjectPnlRow>> {
    this.assertJson(q.format);
    return this.exporter.render(await this.query.profitAndLoss(q, actor)) as ReportResult<ProjectPnlRow>;
  }

  @Get('balance-sheet')
  @Roles({ module: 'RPT', action: 'READ' })
  async balanceSheet(
    @Query() q: BalanceSheetReportQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<ReportResult<BalanceSheetRow>> {
    this.assertJson(q.format);
    return this.exporter.render(await this.query.balanceSheet(q, actor)) as ReportResult<BalanceSheetRow>;
  }

  /** Only `format=json` is wired in this brief; Excel/PDF exporters land in RPT #30 (FR-RPT-029). */
  private assertJson(format?: string): void {
    if (format && format !== 'json') {
      throw new ValidationError(`format '${format}' is not yet available; use json (Excel/PDF land in RPT #30)`, {
        field: 'format',
      });
    }
  }
}
