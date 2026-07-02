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
