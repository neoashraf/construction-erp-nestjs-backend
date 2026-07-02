/**
 * LedgerReadPort (DSH · FR-DSH-011/-017) — PURE domain port. The seam to LED's ledger read surface for
 * the two ledger-sourced tiles: the project-cash-flow summary (net in/out + cash/bank balances) and the
 * top receivables/payables by party. These KPIs are NOT among RPT's existing report reads (RPT exposes a
 * paginated cash-bank-book line list and per-account ledgers, not a netInflow/balance summary or an
 * AR/AP-by-party top-N), so DSH runs the SAME canonical scoped SQL LED uses over `journal_line` ⋈
 * `journal_entry` — one ledger definition: cash/bank balance = Σ(debit − credit) on the cash/bank control
 * accounts, AR/AP outstanding = the party-tagged control-account balance. The cash-flow tile still drills
 * into RPT's `cash-bank-book` report, which reads the same journal lines (FR-DSH-004). DSH NEVER writes;
 * every method is a non-blocking SELECT/aggregate — no PostingService, no migration.
 */
import { CashFlowKpi, PartyOutstandingRow } from '../tile.model';

export const DASHBOARD_LEDGER_READ_PORT = Symbol('DASHBOARD_LEDGER_READ_PORT');

export interface LedgerScope {
  companyId: string;
  /** Effective project filter (F4): `null` = all projects; `[]` = none (valid zero tile); `[ids]` = restricted. */
  projectIds: string[] | null;
  financialYearId?: string;
  /** cash-flow window (net in/out over [dateFrom, dateTo]); balances are cumulative for the FY scope. */
  dateFrom?: string;
  dateTo?: string;
}

export interface LedgerReadPort {
  /** Net cash/bank movement for the window + current cash & bank control-account balances (FR-DSH-011). */
  cashFlow(scope: LedgerScope): Promise<CashFlowKpi>;
  /** Top-N parties by AR / AP control-account outstanding (FR-DSH-017); ≤ N rows, no padding. */
  topReceivablesPayables(
    scope: LedgerScope,
    n: number,
  ): Promise<{ topReceivables: PartyOutstandingRow[]; topPayables: PartyOutstandingRow[] }>;
}
