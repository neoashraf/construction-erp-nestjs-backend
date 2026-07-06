/**
 * TileQueryService (DSH · FR-DSH-004/-011…018) — application. Computes ONE tile: it looks up the
 * descriptor's `source`, calls THAT owning read port (never a parallel computation), summarises the rows
 * into the tile's KPI shape (count / sum / top-N), renders the SOURCE's status classification (FR-DSH-018),
 * and attaches the `drillTo` reference so following it opens the RPT report on the SAME scope (FR-DSH-002).
 *
 * Single source of truth (FR-DSH-004): CC's OVER/APPROACHING rows are COUNTED verbatim; SAL's per-IPC
 * outstanding / retention totals are rendered verbatim; INV's low-stock rows are counted; HR's attendance
 * roll-up is summed; LED's cash/bank + AR/AP-by-party is summarised — DSH re-derives nothing.
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  CostControlReadPort,
  COST_CONTROL_READ_PORT,
} from '../../reports/domain/ports/cost-control.read.port';
import { SalesReadPort, SALES_READ_PORT } from '../../reports/domain/ports/sales.read.port';
import { InventoryReadPort, INVENTORY_READ_PORT } from '../../reports/domain/ports/inventory.read.port';
import { HrReadPort, HR_READ_PORT } from '../../reports/domain/ports/hr.read.port';
import { CostControlVarianceStatus } from '../../reports/domain/report-result.model';
import {
  LedgerReadPort,
  DASHBOARD_LEDGER_READ_PORT,
} from '../domain/ports/ledger.read.port';
import { TileDescriptor } from '../domain/tile-descriptor';
import { DrillTo, Tile, TileStatus } from '../domain/tile.model';
import { TileScope } from './dashboard-scope.service';

/** Top-N size for the receivables/payables tile (FR-DSH-017). */
const TOP_N = 5;

@Injectable()
export class TileQueryService {
  constructor(
    @Inject(COST_CONTROL_READ_PORT) private readonly costControl: CostControlReadPort,
    @Inject(SALES_READ_PORT) private readonly sales: SalesReadPort,
    @Inject(INVENTORY_READ_PORT) private readonly inventory: InventoryReadPort,
    @Inject(HR_READ_PORT) private readonly hr: HrReadPort,
    @Inject(DASHBOARD_LEDGER_READ_PORT) private readonly ledger: LedgerReadPort,
  ) {}

  async compute(descriptor: TileDescriptor, scope: TileScope): Promise<Tile<unknown>> {
    let kpi: unknown;
    let status: TileStatus | null = null;

    switch (descriptor.source) {
      case 'COST_CONTROL': {
        const rows = await this.costControl.budgetVsActual({
          companyId: scope.companyId,
          projectIds: scope.projectIds,
          financialYearId: scope.financialYearId,
        });
        const overCount = rows.filter((r) => r.status === 'OVER').length;
        const approachingCount = rows.filter((r) => r.status === 'APPROACHING').length;
        kpi = { overCount, approachingCount };
        status = this.worstStatus(rows.map((r) => r.status));
        break;
      }
      case 'SALES_IPC': {
        const { rows, totals } = await this.sales.ipcBilling({
          companyId: scope.companyId,
          projectIds: scope.projectIds,
          financialYearId: scope.financialYearId,
          dateFrom: scope.dateFrom,
          dateTo: scope.dateTo,
        });
        kpi =
          descriptor.key === 'pending-ipcs'
            ? {
                count: rows.filter((r) => new Decimal(r.outstandingAmount).greaterThan(0)).length,
                totalOutstanding: totals.outstanding,
              }
            : { totalRetentionHeld: totals.retentionHeld };
        break;
      }
      case 'INVENTORY': {
        const rows = await this.inventory.lowStock({
          companyId: scope.companyId,
          godownId: scope.godownId,
          financialYearId: scope.financialYearId,
          reorderLevel: scope.reorderLevel,
        });
        kpi = { count: rows.length };
        status = rows.length > 0 ? 'BREACH' : 'OK';
        break;
      }
      case 'HR': {
        const month = scope.month ?? this.currentMonth();
        const { items } = await this.hr.attendanceSummary({
          companyId: scope.companyId,
          projectIds: scope.projectIds,
          month,
          pageSize: 200,
        });
        const presentDays = items.reduce((acc, r) => acc + r.daysPresent, 0);
        const headCountTotal = items.reduce((acc, r) => acc.plus(r.headCountTotal), new Decimal(0));
        kpi = { period: month, presentDays, headCountTotal: headCountTotal.toFixed(4) };
        break;
      }
      case 'LEDGER': {
        const ledgerScope = {
          companyId: scope.companyId,
          projectIds: scope.projectIds,
          financialYearId: scope.financialYearId,
          dateFrom: scope.dateFrom,
          dateTo: scope.dateTo,
        };
        kpi =
          descriptor.key === 'project-cash-flow'
            ? await this.ledger.cashFlow(ledgerScope)
            : await this.ledger.topReceivablesPayables(ledgerScope, TOP_N);
        break;
      }
    }

    return {
      key: descriptor.key,
      title: descriptor.title,
      kpi,
      status,
      drillTo: this.drillTo(descriptor, scope),
      generatedAt: new Date().toISOString(),
    };
  }

  /** The worst CC status across the rows — OVER > APPROACHING > OK (UNBUDGETED is not an alert). */
  private worstStatus(statuses: CostControlVarianceStatus[]): TileStatus {
    if (statuses.includes('OVER')) return 'OVER';
    if (statuses.includes('APPROACHING')) return 'APPROACHING';
    return 'OK';
  }

  /** Build the drill-down params so following `drillTo` opens the RPT report on the tile's scope (FR-DSH-002). */
  private drillTo(descriptor: TileDescriptor, scope: TileScope): DrillTo {
    const params: Record<string, unknown> = {
      financialYearId: scope.financialYearId ?? null,
      projectId: scope.requestedProjectId,
    };
    if (descriptor.key === 'project-cash-flow') {
      params.dateFrom = scope.dateFrom ?? null;
      params.dateTo = scope.dateTo ?? null;
    }
    if (descriptor.key === 'retention-held') params.view = 'retention';
    if (descriptor.key === 'over-budget') params.status = 'OVER,APPROACHING';
    if (descriptor.key === 'attendance-summary') params.month = scope.month ?? this.currentMonth();
    if (descriptor.key === 'low-stock') params.godownId = scope.godownId ?? null;
    return { report: descriptor.drillToReport, params };
  }

  private currentMonth(): string {
    return new Date().toISOString().slice(0, 7);
  }
}
