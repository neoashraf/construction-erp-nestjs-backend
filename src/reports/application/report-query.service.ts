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
import Decimal from 'decimal.js';
import { ValidationError } from '../../common/errors/domain-error';
import { Actor } from '../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../infrastructure/http/pagination';
import {
  AccountLedgerRow,
  AttendanceSummaryRow,
  BalanceSheetRow,
  CostCentreVarianceRow,
  CostControlVarianceStatus,
  EmployeePaymentRow,
  IpcBillingRow,
  LabourCostRow,
  ProjectPnlRow,
  ReportResult,
  RequisitionVsIssueRow,
  SalaryRegisterRow,
  StockMovementSummaryRow,
  StockValuationRow,
  TrialBalanceRow,
} from '../domain/report-result.model';
import { LedgerReadPort, LedgerScope, LEDGER_READ_PORT } from '../domain/ports/ledger.read.port';
import { InventoryReadPort, INVENTORY_READ_PORT } from '../domain/ports/inventory.read.port';
import { RequisitionReadPort, REQUISITION_READ_PORT } from '../domain/ports/requisition.read.port';
import { HrReadPort, HR_READ_PORT } from '../domain/ports/hr.read.port';
import { SalesReadPort, SALES_READ_PORT } from '../domain/ports/sales.read.port';
import { CostControlReadPort, COST_CONTROL_READ_PORT } from '../domain/ports/cost-control.read.port';
import { ageingBucket } from '../domain/ageing';
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

export interface StockValuationParams {
  godownId?: string;
  itemId?: string;
  asOf?: string;
  financialYearId?: string;
  page?: number;
  pageSize?: number;
}

export interface LowStockParams extends StockValuationParams {
  reorderLevel?: string;
}

export interface StockTransferParams {
  godownId?: string;
  itemId?: string;
  financialYearId?: string;
  projectId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface RequisitionVsIssueParams {
  projectId?: string;
  costCentreId?: string;
  requisitionId?: string;
  financialYearId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface AttendanceParams {
  month?: string;
  projectId?: string;
  employeeId?: string;
  costCentreId?: string;
  page?: number;
  pageSize?: number;
}

export interface SalaryRegisterParams {
  salaryRunId?: string;
  financialYearId?: string;
  month?: string;
  projectId?: string;
  page?: number;
  pageSize?: number;
}

export interface EmployeePaymentParams {
  employeeId?: string;
  financialYearId?: string;
  dateFrom?: string;
  dateTo?: string;
  projectId?: string;
  page?: number;
  pageSize?: number;
}

export interface ProjectPnlParams {
  financialYearId?: string;
  projectId?: string;
  costCentreId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface IpcBillingParams {
  financialYearId?: string;
  projectId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface OutstandingParams {
  financialYearId?: string;
  projectId?: string;
  asOf?: string;
}

export interface CostCentreVarianceParams {
  financialYearId?: string;
  projectId?: string;
  costCentreId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
}

export interface LabourCostParams {
  financialYearId?: string;
  projectId?: string;
  costCentreId?: string;
  dateFrom?: string;
  dateTo?: string;
}

const ALL_VARIANCE_STATUSES: CostControlVarianceStatus[] = ['OK', 'APPROACHING', 'OVER', 'UNBUDGETED'];

@Injectable()
export class ReportQueryService {
  constructor(
    @Inject(LEDGER_READ_PORT) private readonly ledger: LedgerReadPort,
    @Inject(INVENTORY_READ_PORT) private readonly inventory: InventoryReadPort,
    @Inject(REQUISITION_READ_PORT) private readonly requisition: RequisitionReadPort,
    @Inject(HR_READ_PORT) private readonly hr: HrReadPort,
    private readonly scope: ReportScopeService,
    @Inject(SALES_READ_PORT) private readonly sales: SalesReadPort,
    @Inject(COST_CONTROL_READ_PORT) private readonly costControl: CostControlReadPort,
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

  // ── stock valuation (FR-RPT-021) ─────────────────────────────────────────────────────────────────
  async stockValuation(p: StockValuationParams, actor: Actor): Promise<ReportResult<StockValuationRow>> {
    const { rows, totalValue } = await this.inventory.stockValuation({
      companyId: actor.companyId,
      godownId: p.godownId,
      itemId: p.itemId,
      asOf: p.asOf,
      financialYearId: p.financialYearId,
    });
    return this.result(
      'stock-valuation',
      { financialYearId: p.financialYearId ?? null, godownId: p.godownId ?? null, itemId: p.itemId ?? null, asOf: p.asOf ?? null },
      rows,
      { totalValue },
    );
  }

  // ── low stock / re-order (FR-RPT-022) ────────────────────────────────────────────────────────────
  async lowStock(p: LowStockParams, actor: Actor): Promise<ReportResult<StockValuationRow>> {
    // MAS holds no reorder attribute (§15) — the threshold MUST be supplied as a report param.
    if (p.reorderLevel === undefined || p.reorderLevel === null || p.reorderLevel === '') {
      throw new ValidationError('reorderLevel is required (no MAS reorder attribute exists)', {
        field: 'reorderLevel',
      });
    }
    const rows = await this.inventory.lowStock({
      companyId: actor.companyId,
      godownId: p.godownId,
      itemId: p.itemId,
      asOf: p.asOf,
      reorderLevel: p.reorderLevel,
      financialYearId: p.financialYearId,
    });
    return this.result(
      'low-stock',
      { financialYearId: p.financialYearId ?? null, godownId: p.godownId ?? null, reorderLevel: p.reorderLevel, asOf: p.asOf ?? null },
      rows,
      null,
    );
  }

  // ── stock-journal transfer / issue summary (FR-RPT-023) ──────────────────────────────────────────
  async stockTransferSummary(p: StockTransferParams, actor: Actor): Promise<Paginated<StockMovementSummaryRow>> {
    this.assertDateRange(p);
    const { projectIds } = this.scope.resolve(actor, p.projectId);
    const { items, total } = await this.inventory.movementSummary({
      companyId: actor.companyId,
      projectIds,
      godownId: p.godownId,
      itemId: p.itemId,
      financialYearId: p.financialYearId,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
      page: p.page,
      pageSize: p.pageSize,
    });
    const { page, pageSize } = resolvePaging(p);
    return new Paginated(items, page, pageSize, total);
  }

  // ── requisition vs issue (FR-RPT-024) ────────────────────────────────────────────────────────────
  async requisitionVsIssue(p: RequisitionVsIssueParams, actor: Actor): Promise<Paginated<RequisitionVsIssueRow>> {
    this.assertDateRange(p);
    const { projectIds } = this.scope.resolve(actor, p.projectId);
    const { items, total } = await this.requisition.requisitionVsIssue({
      companyId: actor.companyId,
      projectIds,
      costCentreId: p.costCentreId,
      requisitionId: p.requisitionId,
      financialYearId: p.financialYearId,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
      page: p.page,
      pageSize: p.pageSize,
    });
    // varianceQty = requestedQty − issuedQty (RPT derives the arithmetic from REQ's figures, FR-RPT-024).
    const rows: RequisitionVsIssueRow[] = items.map((r) => ({
      ...r,
      varianceQty: new Decimal(r.requestedQty).minus(r.issuedQty).toFixed(4),
    }));
    const { page, pageSize } = resolvePaging(p);
    return new Paginated(rows, page, pageSize, total);
  }

  // ── attendance summary (FR-RPT-026) ──────────────────────────────────────────────────────────────
  async attendanceSummary(p: AttendanceParams, actor: Actor): Promise<Paginated<AttendanceSummaryRow>> {
    if (!p.month) throw new ValidationError('month is required (YYYY-MM)', { field: 'month' });
    const { projectIds } = this.scope.resolve(actor, p.projectId);
    const { items, total } = await this.hr.attendanceSummary({
      companyId: actor.companyId,
      projectIds,
      month: p.month,
      employeeId: p.employeeId,
      costCentreId: p.costCentreId,
      page: p.page,
      pageSize: p.pageSize,
    });
    const { page, pageSize } = resolvePaging(p);
    return new Paginated(items, page, pageSize, total);
  }

  // ── salary register (FR-RPT-027) ─────────────────────────────────────────────────────────────────
  async salaryRegister(p: SalaryRegisterParams, actor: Actor): Promise<ReportResult<SalaryRegisterRow>> {
    if (!p.salaryRunId && !(p.financialYearId && p.month)) {
      throw new ValidationError('salaryRunId, or financialYearId + month, is required', { field: 'salaryRunId' });
    }
    const { projectIds } = this.scope.resolve(actor, p.projectId);
    const { rows, totals } = await this.hr.salaryRegister({
      companyId: actor.companyId,
      projectIds,
      salaryRunId: p.salaryRunId,
      financialYearId: p.financialYearId,
      month: p.month,
      projectId: p.projectId,
    });
    return this.result(
      'salary-register',
      { salaryRunId: p.salaryRunId ?? null, financialYearId: p.financialYearId ?? null, month: p.month ?? null, projectId: p.projectId ?? null },
      rows,
      totals,
    );
  }

  // ── employee payment history (FR-RPT-028) ────────────────────────────────────────────────────────
  async employeePaymentHistory(p: EmployeePaymentParams, actor: Actor): Promise<Paginated<EmployeePaymentRow>> {
    this.assertDateRange(p);
    const { projectIds } = this.scope.resolve(actor, p.projectId);
    const { items, total } = await this.hr.employeePayments({
      companyId: actor.companyId,
      projectIds,
      employeeId: p.employeeId,
      financialYearId: p.financialYearId,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
      page: p.page,
      pageSize: p.pageSize,
    });
    const { page, pageSize } = resolvePaging(p);
    return new Paginated(items, page, pageSize, total);
  }

  // ── project P&L (FR-RPT-015) ─────────────────────────────────────────────────────────────────────
  /**
   * Per-cost-centre revenue/cost/profit for a single project + a project total row (`costCentreId = null`),
   * reusing LED's P&L aggregation grouped by cost centre. `profit = revenue − cost` — equal to CC's project
   * profitability for the same params (FR-RPT-015; CC FR-CC-009). RPT does not recompute the math.
   */
  async projectPnl(p: ProjectPnlParams, actor: Actor): Promise<ReportResult<ProjectPnlRow>> {
    this.assertDateRange(p);
    const scope = this.buildScope({ ...p, groupBy: 'cost_centre' }, actor);
    const { rows, totals } = await this.ledger.profitAndLoss(scope);
    const projectId = p.projectId ?? null;
    // LED grouped by cost centre carries no project_id column — stamp the requested project on each row.
    const perCostCentre: ProjectPnlRow[] = rows.map((r) => ({ ...r, projectId }));
    // Project total row (costCentreId = null) — the reconciling revenue/cost/profit for the project.
    const totalRow: ProjectPnlRow = {
      projectId,
      costCentreId: null,
      revenue: totals.revenue,
      cost: totals.cost,
      profit: totals.profit,
    };
    return this.result(
      'project-pnl',
      {
        financialYearId: p.financialYearId ?? null,
        projectId,
        costCentreId: p.costCentreId ?? null,
        dateFrom: p.dateFrom ?? null,
        dateTo: p.dateTo ?? null,
      },
      [...perCostCentre, totalRow],
      totals,
    );
  }

  // ── IPC billing (FR-RPT-016/-017) ────────────────────────────────────────────────────────────────
  /**
   * Per-IPC certified/billed/received/outstanding/retention (SAL's figures VERBATIM) + the project
   * cumulative totals; RPT adds ONLY the ageing bucket (FR-RPT-017) derived from SAL's outstanding + the IPC
   * due date relative to the report as-of (today). A reversed receipt raises outstanding on the next run.
   */
  async ipcBilling(p: IpcBillingParams, actor: Actor): Promise<ReportResult<IpcBillingRow>> {
    this.assertDateRange(p);
    const { companyId, projectIds } = this.scope.resolve(actor, p.projectId);
    const { rows, totals } = await this.sales.ipcBilling({
      companyId,
      projectIds,
      financialYearId: p.financialYearId,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
    });
    const asOf = this.today();
    const withAgeing: IpcBillingRow[] = rows.map((r) => ({ ...r, ageingBucket: ageingBucket(r.dueDate, asOf) }));
    return this.result(
      'ipc-billing',
      { financialYearId: p.financialYearId ?? null, projectId: p.projectId ?? null, dateFrom: p.dateFrom ?? null, dateTo: p.dateTo ?? null },
      withAgeing,
      totals as unknown as Record<string, string>,
    );
  }

  // ── outstanding per project & IPC (FR-RPT-020) ────────────────────────────────────────────────────
  /**
   * Receivables outstanding per IPC (SAL's per-IPC outstanding VERBATIM) with per-project rolled-up totals,
   * so a project total = Σ its IPC outstanding and reconciles to SAL. Ageing is relative to `asOf` (or today).
   */
  async outstanding(p: OutstandingParams, actor: Actor): Promise<ReportResult<IpcBillingRow>> {
    const { companyId, projectIds } = this.scope.resolve(actor, p.projectId);
    const { rows } = await this.sales.ipcBilling({ companyId, projectIds, financialYearId: p.financialYearId });
    const asOf = p.asOf ?? this.today();
    const withAgeing: IpcBillingRow[] = rows.map((r) => ({ ...r, ageingBucket: ageingBucket(r.dueDate, asOf) }));
    // Per-project rolled-up outstanding (project total = Σ its IPC outstanding), plus a grand total.
    const perProject: Record<string, string> = {};
    let grand = new Decimal(0);
    for (const r of withAgeing) {
      perProject[r.projectId] = new Decimal(perProject[r.projectId] ?? '0').plus(r.outstandingAmount).toFixed(4);
      grand = grand.plus(r.outstandingAmount);
    }
    return this.result(
      'outstanding',
      { financialYearId: p.financialYearId ?? null, projectId: p.projectId ?? null, asOf: p.asOf ?? null },
      withAgeing,
      { ...perProject, outstanding: grand.toFixed(4) },
    );
  }

  // ── material consumption vs budget (FR-RPT-018) ───────────────────────────────────────────────────
  /** CC's budget-vs-actual per (project, cost centre) rendered VERBATIM — actual = consumed cost (FR-RPT-018). */
  async materialConsumptionVsBudget(
    p: LabourCostParams,
    actor: Actor,
  ): Promise<ReportResult<CostCentreVarianceRow>> {
    this.assertDateRange(p);
    const rows = await this.costControl.budgetVsActual(this.costControlScope(p, actor));
    return this.result(
      'material-consumption-vs-budget',
      { financialYearId: p.financialYearId ?? null, projectId: p.projectId ?? null, costCentreId: p.costCentreId ?? null, dateFrom: p.dateFrom ?? null, dateTo: p.dateTo ?? null },
      rows,
      null,
    );
  }

  // ── labour cost per cost centre (FR-RPT-019) ──────────────────────────────────────────────────────
  /** Σ(debit − credit) on labour EXPENSE accounts grouped by cost centre, for a project or across projects. */
  async labourCost(p: LabourCostParams, actor: Actor): Promise<ReportResult<LabourCostRow>> {
    this.assertDateRange(p);
    const scope = this.buildScope(p, actor);
    const { rows, totals } = await this.ledger.labourCost(scope);
    return this.result(
      'labour-cost',
      { financialYearId: p.financialYearId ?? null, projectId: p.projectId ?? null, costCentreId: p.costCentreId ?? null, dateFrom: p.dateFrom ?? null, dateTo: p.dateTo ?? null },
      rows,
      totals,
    );
  }

  // ── cost-centre variance (FR-RPT-025) ─────────────────────────────────────────────────────────────
  /**
   * CC's budget-vs-actual per (project, cost centre) rendered VERBATIM (actual/variance/utilisation/status,
   * incl. UNBUDGETED with null budget/variance) — RPT never recomputes variance (FR-RPT-025). An optional
   * `status` csv filters the rows (validated against the CC status enum).
   */
  async costCentreVariance(
    p: CostCentreVarianceParams,
    actor: Actor,
  ): Promise<ReportResult<CostCentreVarianceRow>> {
    this.assertDateRange(p);
    const statuses = this.parseVarianceStatuses(p.status);
    const all = await this.costControl.budgetVsActual(this.costControlScope(p, actor));
    const rows = statuses ? all.filter((r) => statuses.has(r.status)) : all;
    return this.result(
      'cost-centre-variance',
      { financialYearId: p.financialYearId ?? null, projectId: p.projectId ?? null, costCentreId: p.costCentreId ?? null, dateFrom: p.dateFrom ?? null, dateTo: p.dateTo ?? null, status: p.status ?? null },
      rows,
      null,
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private costControlScope(p: CostCentreVarianceParams, actor: Actor) {
    const { companyId, projectIds } = this.scope.resolve(actor, p.projectId);
    return {
      companyId,
      projectIds,
      financialYearId: p.financialYearId,
      costCentreId: p.costCentreId,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
    };
  }

  private parseVarianceStatuses(csv: string | undefined): Set<CostControlVarianceStatus> | null {
    if (!csv) return null;
    const tokens = csv.split(',').map((t) => t.trim()).filter(Boolean);
    const set = new Set<CostControlVarianceStatus>();
    for (const t of tokens) {
      if (!ALL_VARIANCE_STATUSES.includes(t as CostControlVarianceStatus)) {
        throw new ValidationError(`Unknown status '${t}'`, { allowed: ALL_VARIANCE_STATUSES });
      }
      set.add(t as CostControlVarianceStatus);
    }
    return set.size > 0 ? set : null;
  }

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

  /** Generic ReportResult assembler for the inventory/HR reports (their param sets differ from LED's). */
  private result<Row>(
    reportName: string,
    parameters: Record<string, unknown>,
    rows: Row[],
    totals: Record<string, string> | null,
  ): ReportResult<Row> {
    return { reportName, parameters, rows, totals, generatedAt: new Date().toISOString() };
  }
}
