/**
 * LedgerReadPort (RPT · FR-RPT-004/-009…014) — PURE domain port. The seam to LED's ledger read surface.
 * RPT depends on this by interface; the adapter (infrastructure) runs the SAME canonical scoped SQL LED
 * uses over `journal_line` ⋈ `journal_entry` ⋈ `account`/`account_group` (single source of truth — the
 * numbers equal LED's own trial-balance for the same params). RPT NEVER writes; every method is a
 * non-blocking SELECT/aggregate.
 *
 * Scope carries company (always — never global), the effective project filter (F3/F4 resolved by
 * ReportScopeService), the FY, the optional dimension filters, and either a `voucher_date` range OR an
 * as-of `periodId`/date (period/as-of takes precedence on balance reports — SRS §4).
 */
import {
  AccountLedgerRow,
  BalanceSheetRow,
  LabourCostRow,
  ProjectPnlRow,
  TrialBalanceRow,
} from '../report-result.model';

export const LEDGER_READ_PORT = Symbol('LEDGER_READ_PORT');

export interface LedgerScope {
  companyId: string;
  financialYearId?: string;
  /**
   * The effective project filter (F4): `null` = all projects (unscoped); `[]` = none (a project-scoped
   * user with no assignments → a valid empty report); `[ids]` = restricted to those projects.
   */
  projectIds: string[] | null;
  costCentreId?: string;
  purposeId?: string;
  godownId?: string;
  partyId?: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** As-of period end (balance reports) — takes precedence over the date range. */
  periodId?: string;
  /** As-of date (balance reports) — takes precedence over the date range. */
  asOf?: string;
  /** Trial-balance / P&L grouping tokens, csv (default 'account' / 'project'). */
  groupBy?: string;
  voucherType?: string;
  page?: number;
  pageSize?: number;
}

export interface PaginatedRows<Row> {
  items: Row[];
  total: number;
  /** Opening carry before `dateFrom` for a single-account ledger / cash-bank book. */
  openingBalance?: string;
}

export interface LedgerReadPort {
  /** Trial balance — grouped Dr/Cr/net + balancing totals (FR-RPT-009). */
  trialBalance(scope: LedgerScope): Promise<{ rows: TrialBalanceRow[]; totals: { debit: string; credit: string } }>;
  /** Account ledger — opening balance + chronological lines with a cross-page running balance (FR-RPT-010). */
  accountLedger(scope: LedgerScope): Promise<PaginatedRows<AccountLedgerRow>>;
  /** Daybook — all lines in a date window, chronological, source-traceable (FR-RPT-011). */
  daybook(scope: LedgerScope): Promise<PaginatedRows<AccountLedgerRow>>;
  /** Cash/bank book — account-ledger shape restricted to cash/bank accounts (FR-RPT-012). */
  cashBankBook(scope: LedgerScope): Promise<PaginatedRows<AccountLedgerRow>>;
  /** Profit & loss — revenue/cost/profit grouped by project (± cost centre) (FR-RPT-013). */
  profitAndLoss(scope: LedgerScope): Promise<{ rows: ProjectPnlRow[]; totals: { revenue: string; cost: string; profit: string } }>;
  /** Balance sheet — asset/liability/equity by account group; assets = liabilities + equity (FR-RPT-014). */
  balanceSheet(scope: LedgerScope): Promise<{ rows: BalanceSheetRow[]; totals: { assets: string; liabilities: string; equity: string } }>;
  /**
   * Labour cost — Σ(debit − credit) on labour EXPENSE accounts (codes '5110' Labour, '6100' Salary) grouped
   * by cost centre (± project), for a project or across projects (FR-RPT-019).
   */
  labourCost(scope: LedgerScope): Promise<{ rows: LabourCostRow[]; totals: { labourCost: string } }>;
}
