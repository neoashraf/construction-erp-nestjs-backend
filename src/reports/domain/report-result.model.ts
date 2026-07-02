/**
 * ReportResult<Row> + the LED report row shapes (RPT · SRS §8) — PURE domain DTOs, NOT tables. RPT owns
 * no persistent entity; these are the format-neutral models a report computes once and the FileExporter
 * renders to JSON / Excel / PDF (FR-RPT-029). Money is `Decimal(18,4)` serialised as decimal strings
 * (e.g. '1375000.0000') — never float (overview §8). Dates are ISO 'YYYY-MM-DD' in JSON.
 */

/** The generic report envelope (SRS §8 ReportResult). `totals` reconciles to the ledger by construction. */
export interface ReportResult<Row> {
  reportName: string;
  /** The resolved parameters used to compute the result (company implicit). */
  parameters: Record<string, unknown>;
  rows: Row[];
  /** Reconciling totals where the report has them (TB {debit,credit}; P&L {revenue,cost,profit}). */
  totals: Record<string, string> | null;
  /** When the query ran (ISO-8601 UTC). */
  generatedAt: string;
}

/** Trial balance row — grouped Dr/Cr/net over LED (FR-RPT-009). `totals.debit === totals.credit`. */
export interface TrialBalanceRow {
  accountId: string | null;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  godownId: string | null;
  partyId: string | null;
  debit: string;
  credit: string;
  /** `debit − credit` (debit-positive). */
  net: string;
}

/** Account-ledger / daybook / cash-bank-book row over LED (FR-RPT-010/-011/-012). */
export interface AccountLedgerRow {
  entryId: string;
  entryNo: string;
  voucherType: string;
  voucherDate: string;
  /** Traceability to the originating voucher (FR-LED-030). */
  sourceType: string;
  sourceId: string;
  accountId: string;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  godownId: string | null;
  partyId: string | null;
  debit: string;
  credit: string;
  narration: string | null;
  /** Cumulative, server-computed, debit-positive; carries across pages (account-ledger / cash-bank-book). */
  runningBalance?: string;
}

/** Project P&L row over LED (FR-RPT-013/-015). */
export interface ProjectPnlRow {
  projectId: string | null;
  costCentreId: string | null;
  /** Σ(credit − debit) on INCOME accounts. */
  revenue: string;
  /** Σ(debit − credit) on EXPENSE accounts. */
  cost: string;
  /** `revenue − cost`. */
  profit: string;
}

/**
 * IPC billing row over SAL's per-IPC outstanding / cumulative billing / retention (FR-RPT-016/-017/-020).
 * Every money figure is SAL's definition (FR-SAL-015/-016/-019) rendered VERBATIM — RPT never re-totals.
 * `ageingBucket` is the ONLY field RPT derives, from SAL's `outstandingAmount` + `dueDate` (FR-RPT-017) —
 * a display classification, not a parallel total.
 */
export interface IpcBillingRow {
  ipcId: string;
  projectId: string;
  /** Legal IPC (Mushak) number. */
  ipcNo: string | null;
  ipcDate: string;
  dueDate: string;
  /** Gross certified (SAL). */
  certifiedAmount: string;
  /** Currently-due + retention + advance recovered + VAT (SAL). */
  billedAmount: string;
  /** Receipts applied to this IPC (REC). */
  receivedAmount: string;
  /** `currentlyDue − received` (SAL per-IPC outstanding, FR-SAL-016). */
  outstandingAmount: string;
  /** Retention withheld − released (SAL, FR-SAL-019). */
  retentionHeld: string;
  /** Age of `outstandingAmount` from `dueDate` (FR-RPT-017) — RPT-derived display bucket. */
  ageingBucket: AgeingBucket;
}

/** Labour-cost row over LED (FR-RPT-019) — Σ(debit − credit) on labour EXPENSE accounts by cost centre. */
export interface LabourCostRow {
  projectId: string | null;
  costCentreId: string | null;
  /** Σ(debit − credit) on labour EXPENSE accounts ('5110' Labour, '6100' Salary). */
  labourCost: string;
}

/**
 * Cost-centre variance row consuming CC's canonical budget-vs-actual metric (FR-RPT-025). Every figure is
 * CC's for the same parameters — RPT renders `actualCost`/`variance`/`utilisationPct`/`status` VERBATIM and
 * never recomputes variance. `budgetedAmount`/`variance`/`utilisationPct` are null when `status=UNBUDGETED`.
 */
export interface CostCentreVarianceRow {
  projectId: string;
  costCentreId: string;
  /** CC `budgetedAmount` (MAS `ProjectBudget`); null when UNBUDGETED. */
  budgetedAmount: string | null;
  /** CC `actualCost` (FR-CC-006) — RPT does not recompute. */
  actualCost: string;
  /** CC `variance` (= budgeted − actual); null when UNBUDGETED. */
  variance: string | null;
  /** CC `utilisationPct`; null when UNBUDGETED. */
  utilisationPct: string | null;
  /** CC `status` — RPT renders CC's classification, never invents one. */
  status: CostControlVarianceStatus;
}

/** CC's budget-vs-actual classification (mirrors CC's `CostControlStatus`) — rendered verbatim by RPT. */
export type CostControlVarianceStatus = 'OK' | 'APPROACHING' | 'OVER' | 'UNBUDGETED';

/** IPC / receivable ageing bucket (FR-RPT-017) — a presentation classification, not a total. */
export type AgeingBucket = 'CURRENT' | 'D31_60' | 'D61_90' | 'D90_PLUS';

/** Balance-sheet row grouped by MAS `AccountGroup` over LED (FR-RPT-014). */
export interface BalanceSheetRow {
  accountGroupId: string | null;
  accountGroup: string;
  /** ASSET | LIABILITY | EQUITY. */
  accountType: string;
  /** Natural-sign balance of the group (assets debit-positive; liabilities/equity credit-positive). */
  balance: string;
  projectId: string | null;
}

/**
 * Stock-valuation / low-stock row over INV's stock-ledger projection (FR-RPT-021/-022). Every figure is
 * INV's (`stock_balance` snapshot, or the as-of running balance carried on `stock_movement`) — RPT NEVER
 * recomputes valuation. `totals.totalValue` reconciles to the inventory control-account balance ('1300',
 * FR-INV-005). `weightedAverageRate` is null when quantity is 0 (SRS edge 11).
 */
export interface StockValuationRow {
  godownId: string;
  itemId: string;
  /** From INV (FR-INV-004). */
  quantityOnHand: string;
  /** From INV — reconciles to the inventory control account (FR-INV-005). */
  totalValue: string;
  /** From INV; null when quantity is 0. */
  weightedAverageRate: string | null;
  /** The re-order threshold (MAS attribute or the `reorderLevel` param — §15); drives low-stock. */
  reorderLevel: string | null;
  /** The valuation date; null for a live (current) snapshot. */
  asOfDate: string | null;
}

/** Stock-journal transfer/issue summary row over INV's Stock Journal read surface (FR-RPT-023). */
export interface StockMovementSummaryRow {
  stockJournalId: string;
  voucherNo: string | null;
  voucherDate: string;
  fromGodownId: string | null;
  toGodownId: string | null;
  itemId: string;
  quantity: string;
  value: string | null;
  /** TRANSFER | ISSUE | ADJUSTMENT. */
  mode: string;
  approverId: string | null;
}

/** Requisition-vs-issue row over REQ's requisition/issue read surface (FR-RPT-024). */
export interface RequisitionVsIssueRow {
  requisitionId: string;
  projectId: string | null;
  costCentreId: string | null;
  itemId: string;
  requestedQty: string;
  issuedQty: string;
  /** `requestedQty − issuedQty` (the unfulfilled/wastage balance) — computed by RPT from REQ figures. */
  varianceQty: string;
}

/** Monthly attendance roll-up row over HR's attendance read surface (FR-RPT-026). */
export interface AttendanceSummaryRow {
  projectId: string | null;
  employeeId: string | null;
  partyId: string | null;
  costCentreId: string | null;
  daysPresent: number;
  paidLeave: number;
  unpaidLeave: number;
  absent: number;
  /** Σ head count (office rows count as 1; subcontractor/daily-labour rows carry an explicit head count). */
  headCountTotal: number;
}

/**
 * Salary-register row over HR's salary-sheet read surface (FR-RPT-027). Every figure is HR's
 * `salary_sheet_line`; the register `totals` reconcile to the posted SALARY ledger entry — RPT renders,
 * never recomputes salary math.
 */
export interface SalaryRegisterRow {
  employeeId: string;
  projectId: string | null;
  costCentreId: string | null;
  gross: string;
  allowances: string;
  tds: string;
  pf: string;
  advanceRecovery: string;
  other: string;
  net: string;
}

/** Employee payment-history row over PAY's payment_allocation/payment_voucher read surface (FR-RPT-028). */
export interface EmployeePaymentRow {
  employeeId: string | null;
  paymentDate: string;
  paidAmount: string;
  /** SALARY | LABOUR_PAYABLE. */
  payableType: string;
  /** The settled payable's id (salary sheet run / labour payable) — traceability to the payable. */
  payableRef: string;
}
