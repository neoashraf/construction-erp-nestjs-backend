/**
 * ReportQueryService (RPT · FR-RPT-002/-004/-009…014) — application. The single place each LED financial
 * report is assembled: validate params (§11) → resolve company + project scope (ReportScopeService, F3/F4)
 * → read the owning source through `LedgerReadPort` (never a parallel computation, FR-RPT-004) → assemble
 * a format-neutral `ReportResult` with its reconciling `totals`. RPT writes nothing; every call is a
 * non-blocking read whose totals tie to the ledger by construction (TB debit=credit; P&L profit=rev−cost;
 * balance sheet assets=liab+equity).
 *
 * Non-paginated reports (trial-balance, profit-and-loss, balance-sheet) return `ReportResult<Row>` (the
 * interceptor wraps it in `data`); paginated reports (account-ledger, daybook, cash-bank-book) return
 * `Paginated<Row>` so the running balance / page info ride `meta` per the platform response model.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '../../common/errors/domain-error';
import { Actor } from '../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../infrastructure/http/pagination';
import {
  AccountLedgerRow,
  BalanceSheetRow,
  ProjectPnlRow,
  ReportResult,
  TrialBalanceRow,
} from '../domain/report-result.model';
import { LedgerReadPort, LedgerScope, LEDGER_READ_PORT } from '../domain/ports/ledger.read.port';
import { ReportScopeService } from './report-scope.service';

export interface CommonReportParams {
  financialYearId?: string;
  projectId?: string;
  costCentreId?: string;
  purposeId?: string;
  godownId?: string;
  partyId?: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  periodId?: string;
  asOf?: string;
  groupBy?: string;
  voucherType?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class ReportQueryService {
  constructor(
    @Inject(LEDGER_READ_PORT) private readonly ledger: LedgerReadPort,
    private readonly scope: ReportScopeService,
  ) {}

  // ── trial balance (FR-RPT-009) ─────────────────────────────────────────────────────────────────
  async trialBalance(p: CommonReportParams, actor: Actor): Promise<ReportResult<TrialBalanceRow>> {
    this.assertDateRange(p);
    const scope = this.buildScope(p, actor);
    const { rows, totals } = await this.ledger.trialBalance(scope);
    return this.assemble('trial-balance', p, rows, totals);
  }

  // ── account ledger (FR-RPT-010) ────────────────────────────────────────────────────────────────
  async accountLedger(p: CommonReportParams, actor: Actor): Promise<Paginated<AccountLedgerRow>> {
    this.assertDateRange(p);
    const scope = this.buildScope(p, actor);
    const { items, total, openingBalance } = await this.ledger.accountLedger(scope);
    const { page, pageSize } = resolvePaging(p);
    return new Paginated(items, page, pageSize, total, { openingBalance });
  }

  // ── daybook (FR-RPT-011) ───────────────────────────────────────────────────────────────────────
  async daybook(p: CommonReportParams, actor: Actor): Promise<Paginated<AccountLedgerRow>> {
    this.assertDateRange(p);
    const scope = this.buildScope(p, actor);
    const { items, total } = await this.ledger.daybook(scope);
    const { page, pageSize } = resolvePaging(p);
    return new Paginated(items, page, pageSize, total);
  }

  // ── cash / bank book (FR-RPT-012) ──────────────────────────────────────────────────────────────
  async cashBankBook(p: CommonReportParams, actor: Actor): Promise<Paginated<AccountLedgerRow>> {
    this.assertDateRange(p);
    const scope = this.buildScope(p, actor);
    const { items, total, openingBalance } = await this.ledger.cashBankBook(scope);
    const { page, pageSize } = resolvePaging(p);
    return new Paginated(items, page, pageSize, total, { openingBalance });
  }

  // ── profit & loss (FR-RPT-013) ─────────────────────────────────────────────────────────────────
  async profitAndLoss(p: CommonReportParams, actor: Actor): Promise<ReportResult<ProjectPnlRow>> {
    this.assertDateRange(p);
    const scope = this.buildScope(p, actor);
    const { rows, totals } = await this.ledger.profitAndLoss(scope);
    return this.assemble('profit-and-loss', p, rows, totals);
  }

  // ── balance sheet (FR-RPT-014) ─────────────────────────────────────────────────────────────────
  async balanceSheet(p: CommonReportParams, actor: Actor): Promise<ReportResult<BalanceSheetRow>> {
    this.assertDateRange(p);
    const scope = this.buildScope(p, actor);
    const { rows, totals } = await this.ledger.balanceSheet(scope);
    return this.assemble('balance-sheet', p, rows, totals);
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────
  private buildScope(p: CommonReportParams, actor: Actor): LedgerScope {
    const { projectIds, companyId } = this.scope.resolve(actor, p.projectId);
    return {
      companyId,
      projectIds,
      financialYearId: p.financialYearId,
      costCentreId: p.costCentreId,
      purposeId: p.purposeId,
      godownId: p.godownId,
      partyId: p.partyId,
      accountId: p.accountId,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
      periodId: p.periodId,
      asOf: p.asOf,
      groupBy: p.groupBy,
      voucherType: p.voucherType,
      page: p.page,
      pageSize: p.pageSize,
    };
  }

  private assertDateRange(p: CommonReportParams): void {
    if (p.dateFrom && p.dateTo && p.dateFrom > p.dateTo) {
      throw new ValidationError('dateFrom must be <= dateTo', { field: 'dateFrom' });
    }
  }

  private assemble<Row>(
    reportName: string,
    p: CommonReportParams,
    rows: Row[],
    totals: Record<string, string> | null,
  ): ReportResult<Row> {
    return {
      reportName,
      parameters: {
        financialYearId: p.financialYearId ?? null,
        projectId: p.projectId ?? null,
        costCentreId: p.costCentreId ?? null,
        dateFrom: p.dateFrom ?? null,
        dateTo: p.dateTo ?? null,
        periodId: p.periodId ?? null,
        asOf: p.asOf ?? null,
        groupBy: p.groupBy ?? null,
      },
      rows,
      totals,
      generatedAt: new Date().toISOString(),
    };
  }
}
