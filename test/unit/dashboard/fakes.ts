/**
 * Configurable fake read ports for the DSH unit tests. Each fake returns a fixed row set so a tile's KPI
 * can be asserted to be a VERBATIM summary of the source (single source of truth, FR-DSH-004) — never a
 * recomputation. Not a test suite (no `.spec` — not picked up by jest).
 */
import {
  CostControlReadPort,
  CostControlScope,
} from '../../../src/reports/domain/ports/cost-control.read.port';
import {
  SalesReadPort,
  SalesScope,
  IpcBillingReadRow,
  IpcBillingTotals,
} from '../../../src/reports/domain/ports/sales.read.port';
import {
  InventoryReadPort,
  InventoryScope,
} from '../../../src/reports/domain/ports/inventory.read.port';
import { HrReadPort, AttendanceScope } from '../../../src/reports/domain/ports/hr.read.port';
import { PaginatedRows } from '../../../src/reports/domain/ports/ledger.read.port';
import {
  AttendanceSummaryRow,
  CostCentreVarianceRow,
  StockValuationRow,
} from '../../../src/reports/domain/report-result.model';
import { LedgerReadPort, LedgerScope } from '../../../src/dashboard/domain/ports/ledger.read.port';
import { CashFlowKpi, PartyOutstandingRow } from '../../../src/dashboard/domain/tile.model';

export class FakeCostControl implements CostControlReadPort {
  lastScope?: CostControlScope;
  constructor(public rows: CostCentreVarianceRow[] = []) {}
  budgetVsActual(scope: CostControlScope): Promise<CostCentreVarianceRow[]> {
    this.lastScope = scope;
    return Promise.resolve(this.rows);
  }
}

export class FakeSales implements SalesReadPort {
  lastScope?: SalesScope;
  constructor(
    public rows: IpcBillingReadRow[] = [],
    public totals: IpcBillingTotals = zeroTotals(),
  ) {}
  ipcBilling(scope: SalesScope): Promise<{ rows: IpcBillingReadRow[]; totals: IpcBillingTotals }> {
    this.lastScope = scope;
    return Promise.resolve({ rows: this.rows, totals: this.totals });
  }
}

export class FakeInventory implements InventoryReadPort {
  lastScope?: InventoryScope;
  constructor(public low: StockValuationRow[] = []) {}
  stockValuation(): Promise<{ rows: StockValuationRow[]; totalValue: string }> {
    return Promise.resolve({ rows: [], totalValue: '0.0000' });
  }
  lowStock(scope: InventoryScope): Promise<StockValuationRow[]> {
    this.lastScope = scope;
    return Promise.resolve(this.low);
  }
  movementSummary(): Promise<PaginatedRows<never>> {
    return Promise.resolve({ items: [], total: 0 });
  }
}

export class FakeHr implements HrReadPort {
  lastScope?: AttendanceScope;
  constructor(public rows: AttendanceSummaryRow[] = []) {}
  salaryRegister(): Promise<{ rows: never[]; totals: Record<string, string> }> {
    return Promise.resolve({ rows: [], totals: {} });
  }
  attendanceSummary(scope: AttendanceScope): Promise<PaginatedRows<AttendanceSummaryRow>> {
    this.lastScope = scope;
    return Promise.resolve({ items: this.rows, total: this.rows.length });
  }
  employeePayments(): Promise<PaginatedRows<never>> {
    return Promise.resolve({ items: [], total: 0 });
  }
}

export class FakeLedger implements LedgerReadPort {
  lastScope?: LedgerScope;
  constructor(
    public cash: CashFlowKpi = { netInflow: '0.0000', cashBalance: '0.0000', bankBalance: '0.0000' },
    public receivables: PartyOutstandingRow[] = [],
    public payables: PartyOutstandingRow[] = [],
  ) {}
  cashFlow(scope: LedgerScope): Promise<CashFlowKpi> {
    this.lastScope = scope;
    return Promise.resolve(this.cash);
  }
  topReceivablesPayables(
    scope: LedgerScope,
    n: number,
  ): Promise<{ topReceivables: PartyOutstandingRow[]; topPayables: PartyOutstandingRow[] }> {
    this.lastScope = scope;
    return Promise.resolve({
      topReceivables: this.receivables.slice(0, n),
      topPayables: this.payables.slice(0, n),
    });
  }
}

export function ccRow(
  status: CostCentreVarianceRow['status'],
  projectId = 'P',
  costCentreId = Math.random().toString(36).slice(2),
): CostCentreVarianceRow {
  return {
    projectId,
    costCentreId,
    budgetedAmount: '1000.0000',
    actualCost: '900.0000',
    variance: '100.0000',
    utilisationPct: '90.00',
    status,
  };
}

export function ipcRow(outstanding: string, retentionHeld = '0.0000'): IpcBillingReadRow {
  return {
    ipcId: Math.random().toString(36).slice(2),
    projectId: 'P',
    ipcNo: 'IPC-1',
    ipcDate: '2026-06-01',
    dueDate: '2026-06-30',
    certifiedAmount: '0.0000',
    billedAmount: '0.0000',
    receivedAmount: '0.0000',
    outstandingAmount: outstanding,
    retentionHeld,
  };
}

export function stockRow(): StockValuationRow {
  return {
    godownId: 'g1',
    itemId: 'i1',
    quantityOnHand: '2.0000',
    totalValue: '100.0000',
    weightedAverageRate: '50.0000',
    reorderLevel: '10.0000',
    asOfDate: null,
  };
}

export function attRow(daysPresent: number, headCountTotal: number): AttendanceSummaryRow {
  return {
    projectId: 'P',
    employeeId: 'e1',
    partyId: null,
    costCentreId: null,
    daysPresent,
    paidLeave: 0,
    unpaidLeave: 0,
    absent: 0,
    headCountTotal,
  };
}

export function partyRow(partyId: string, partyName: string, outstanding: string): PartyOutstandingRow {
  return { partyId, partyName, outstanding };
}

function zeroTotals(): IpcBillingTotals {
  return { certified: '0.0000', billed: '0.0000', received: '0.0000', outstanding: '0.0000', retentionHeld: '0.0000' };
}
