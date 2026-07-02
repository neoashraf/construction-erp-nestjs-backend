/**
 * ReportsController (RPT · PRESENTATION) — the READ-ONLY `/api/reports` surface. There is NO
 * POST/PUT/PATCH/DELETE of any kind here (FR-RPT-003): every route is a `GET` that runs one report's
 * canonical query over LED and returns the rows. Company is implicit from the JWT; a project-scoped user
 * (PM) is filtered server-side to assigned projects (F4) and `403`'d on an explicit unassigned `projectId`
 * (in ReportScopeService). Guards mirror LED/PUR: `@UseGuards(JwtAuthGuard, RolesGuard)` at class level +
 * `@Roles({ module:'RPT', action:'READ' })` on every route (FR-RPT-008; the brief's "reports:financial"
 * permission maps to RPT:READ). The actor is resolved via `@CurrentActor`.
 *
 * Export is a FORMAT parameter, not an endpoint (FR-RPT-029): `format=json` (default) returns the report
 * body wrapped by the platform `{ data, meta }` envelope (paginated reports ride `meta`); `format=excel` /
 * `format=pdf` return a BINARY FILE DOWNLOAD — the one deliberate exception to the envelope (overview §6).
 * The binary response carries `Content-Type`, `Content-Disposition: attachment; filename="…"`, and the
 * request id via `X-Request-Id` (FR-RPT-031). The SAME format-neutral `ReportResult` is handed to the
 * selected `FileExporter`, so a report's numbers are identical across all three formats (FR-RPT-029).
 * Non-paginated reports (trial-balance, profit-and-loss, balance-sheet) return a `ReportResult`; paginated
 * reports (account-ledger, daybook, cash-bank-book) return `Paginated`.
 */
import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Readable } from 'stream';
import { ApiTags } from '@nestjs/swagger';
import { ValidationError } from '../../common/errors/domain-error';
import { Actor } from '../../core/tenancy/tenant-context';
import { CurrentActor } from '../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/presentation/roles.guard';
import { Roles } from '../../core/auth/presentation/roles.decorator';
import { Paginated } from '../../infrastructure/http/pagination';
import { CompanyQueryService } from '../../modules/master-data/company/read/company.query-service';
import { REPORT_CATALOG } from '../domain/report-catalog';
import { ReportDescriptor, ReportFormat } from '../domain/report-descriptor';
import {
  AccountLedgerRow,
  AttendanceSummaryRow,
  BalanceSheetRow,
  EmployeePaymentRow,
  ProjectPnlRow,
  ReportResult,
  RequisitionVsIssueRow,
  SalaryRegisterRow,
  StockMovementSummaryRow,
  StockValuationRow,
  TrialBalanceRow,
} from '../domain/report-result.model';
import {
  BinaryDownload,
  CompanyHeader,
  FileExporter,
  FILE_EXPORTER,
} from '../domain/ports/file-exporter.port';
import { ReportQueryService } from '../application/report-query.service';
import {
  AccountLedgerReportQueryDto,
  AttendanceSummaryReportQueryDto,
  BalanceSheetReportQueryDto,
  CashBankBookReportQueryDto,
  DaybookReportQueryDto,
  EmployeePaymentReportQueryDto,
  LowStockReportQueryDto,
  ProfitAndLossReportQueryDto,
  RequisitionVsIssueReportQueryDto,
  SalaryRegisterReportQueryDto,
  StockTransferReportQueryDto,
  StockValuationReportQueryDto,
  TrialBalanceReportQueryDto,
} from './dto/reports-query.dto';

@ApiTags('Reports')
@Controller('api/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportsController {
  private readonly exporters: Map<ReportFormat, FileExporter>;

  constructor(
    private readonly query: ReportQueryService,
    private readonly company: CompanyQueryService,
    @Inject(FILE_EXPORTER) exporters: FileExporter[],
  ) {
    this.exporters = new Map(exporters.map((e) => [e.format, e]));
  }

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
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<ReportResult<TrialBalanceRow> | StreamableFile> {
    const result = await this.query.trialBalance(q, actor);
    return this.respond(result, q.format, actor, res, req);
  }

  @Get('account-ledger')
  @Roles({ module: 'RPT', action: 'READ' })
  async accountLedger(
    @Query() q: AccountLedgerReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<Paginated<AccountLedgerRow> | StreamableFile> {
    const paged = await this.query.accountLedger(q, actor);
    return this.respondPaged('account-ledger', paged, q, actor, res, req);
  }

  @Get('daybook')
  @Roles({ module: 'RPT', action: 'READ' })
  async daybook(
    @Query() q: DaybookReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<Paginated<AccountLedgerRow> | StreamableFile> {
    const paged = await this.query.daybook(q, actor);
    return this.respondPaged('daybook', paged, q, actor, res, req);
  }

  @Get('cash-bank-book')
  @Roles({ module: 'RPT', action: 'READ' })
  async cashBankBook(
    @Query() q: CashBankBookReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<Paginated<AccountLedgerRow> | StreamableFile> {
    const paged = await this.query.cashBankBook(q, actor);
    return this.respondPaged('cash-bank-book', paged, q, actor, res, req);
  }

  @Get('profit-and-loss')
  @Roles({ module: 'RPT', action: 'READ' })
  async profitAndLoss(
    @Query() q: ProfitAndLossReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<ReportResult<ProjectPnlRow> | StreamableFile> {
    const result = await this.query.profitAndLoss(q, actor);
    return this.respond(result, q.format, actor, res, req);
  }

  @Get('balance-sheet')
  @Roles({ module: 'RPT', action: 'READ' })
  async balanceSheet(
    @Query() q: BalanceSheetReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<ReportResult<BalanceSheetRow> | StreamableFile> {
    const result = await this.query.balanceSheet(q, actor);
    return this.respond(result, q.format, actor, res, req);
  }

  // ── inventory reports (INV:READ) ────────────────────────────────────────────────────────────────

  @Get('stock-valuation')
  @Roles({ module: 'INV', action: 'READ' })
  async stockValuation(
    @Query() q: StockValuationReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<ReportResult<StockValuationRow> | StreamableFile> {
    const result = await this.query.stockValuation(q, actor);
    return this.respond(result, q.format, actor, res, req);
  }

  @Get('low-stock')
  @Roles({ module: 'INV', action: 'READ' })
  async lowStock(
    @Query() q: LowStockReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<ReportResult<StockValuationRow> | StreamableFile> {
    const result = await this.query.lowStock(q, actor);
    return this.respond(result, q.format, actor, res, req);
  }

  @Get('stock-transfer-summary')
  @Roles({ module: 'INV', action: 'READ' })
  async stockTransferSummary(
    @Query() q: StockTransferReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<Paginated<StockMovementSummaryRow> | StreamableFile> {
    const paged = await this.query.stockTransferSummary(q, actor);
    return this.respondPaged('stock-transfer-summary', paged, q, actor, res, req);
  }

  // ── requisition & cost-control reports (REQ:READ) ───────────────────────────────────────────────

  @Get('requisition-vs-issue')
  @Roles({ module: 'REQ', action: 'READ' })
  async requisitionVsIssue(
    @Query() q: RequisitionVsIssueReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<Paginated<RequisitionVsIssueRow> | StreamableFile> {
    const paged = await this.query.requisitionVsIssue(q, actor);
    return this.respondPaged('requisition-vs-issue', paged, q, actor, res, req);
  }

  // ── HR reports (HR:READ — restricted to HR/Admin) ───────────────────────────────────────────────

  @Get('attendance-summary')
  @Roles({ module: 'HR', action: 'READ' })
  async attendanceSummary(
    @Query() q: AttendanceSummaryReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<Paginated<AttendanceSummaryRow> | StreamableFile> {
    const paged = await this.query.attendanceSummary(q, actor);
    return this.respondPaged('attendance-summary', paged, q, actor, res, req);
  }

  @Get('salary-register')
  @Roles({ module: 'HR', action: 'READ' })
  async salaryRegister(
    @Query() q: SalaryRegisterReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<ReportResult<SalaryRegisterRow> | StreamableFile> {
    const result = await this.query.salaryRegister(q, actor);
    return this.respond(result, q.format, actor, res, req);
  }

  @Get('employee-payment-history')
  @Roles({ module: 'HR', action: 'READ' })
  async employeePaymentHistory(
    @Query() q: EmployeePaymentReportQueryDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request & { id?: string },
  ): Promise<Paginated<EmployeePaymentRow> | StreamableFile> {
    const paged = await this.query.employeePaymentHistory(q, actor);
    return this.respondPaged('employee-payment-history', paged, q, actor, res, req);
  }

  // ── format dispatch ───────────────────────────────────────────────────────────────────────────

  /**
   * Render a non-paginated `ReportResult`: JSON → the plain body (interceptor wraps it in `{ data, meta }`);
   * Excel/PDF → a binary file download (headers set here; the StreamableFile bypasses the envelope).
   */
  private async respond<Row>(
    result: ReportResult<Row>,
    format: ReportFormat | undefined,
    actor: Actor,
    res: Response,
    req: Request & { id?: string },
  ): Promise<ReportResult<Row> | StreamableFile> {
    const fmt = format ?? 'json';
    const exporter = this.exporterFor(fmt);
    if (fmt === 'json') return exporter.render(result) as ReportResult<Row>;

    const ctx = { company: await this.companyHeader(actor) };
    const download = exporter.render(result, ctx) as BinaryDownload;
    return this.stream(download, res, req);
  }

  /**
   * Paginated reports (account-ledger, daybook, cash-bank-book): JSON returns the `Paginated` (page info on
   * `meta`); Excel/PDF export the requested page as a `ReportResult` (its reconciling aggregates ride
   * `totals`). Request a larger `pageSize` (capped at 200) for a fuller export.
   */
  private async respondPaged<Row>(
    reportName: string,
    paged: Paginated<Row>,
    q: { format?: ReportFormat; projectId?: string; dateFrom?: string; dateTo?: string; financialYearId?: string },
    actor: Actor,
    res: Response,
    req: Request & { id?: string },
  ): Promise<Paginated<Row> | StreamableFile> {
    const fmt = q.format ?? 'json';
    if (fmt === 'json') return paged;

    const result: ReportResult<Row> = {
      reportName,
      parameters: {
        financialYearId: q.financialYearId ?? null,
        projectId: q.projectId ?? null,
        dateFrom: q.dateFrom ?? null,
        dateTo: q.dateTo ?? null,
      },
      rows: paged.items,
      totals: (paged.extraMeta as Record<string, string> | undefined) ?? null,
      generatedAt: new Date().toISOString(),
    };
    const ctx = { company: await this.companyHeader(actor) };
    const download = this.exporterFor(fmt).render(result, ctx) as BinaryDownload;
    return this.stream(download, res, req);
  }

  private stream(download: BinaryDownload, res: Response, req: Request & { id?: string }): StreamableFile {
    const requestId = req.id ?? (req.headers['x-request-id'] as string | undefined) ?? '';
    res.setHeader('Content-Type', download.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
    res.setHeader('X-Request-Id', requestId);
    return new StreamableFile(download.stream as Readable);
  }

  private exporterFor(format: ReportFormat): FileExporter {
    const exporter = this.exporters.get(format);
    if (!exporter) {
      throw new ValidationError(`format '${format}' is not supported`, { field: 'format' });
    }
    return exporter;
  }

  /** The company BIN/TIN block for statutory exports (FR-RPT-030); null if the company is unavailable. */
  private async companyHeader(actor: Actor): Promise<CompanyHeader | null> {
    const c = await this.company.getById(actor.companyId, actor);
    if (!c) return null;
    return { name: c.name, legalName: c.legalName, bin: c.bin, tin: c.tin, address: c.address };
  }
}
