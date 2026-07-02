/**
 * LedgerReadAdapter (RPT · FR-RPT-004/-009…014) — INFRASTRUCTURE `LedgerReadPort`. Runs the SAME canonical
 * scoped SQL LED's `LedgerQueryService` uses over `journal_line` ⋈ `journal_entry` (⋈ `account` /
 * `account_group` for P&L / balance-sheet classification), so RPT's numbers equal LED's for the same
 * params (single source of truth) and every total ties to the ledger by construction. LED's read service
 * is NOT exported from `PostingModule` and the brief forbids modifying LED, so RPT runs the identical
 * aggregation directly via `@Inject(DATA_SOURCE)` — never a second, drifting definition.
 *
 * Read-only: only SELECT/aggregate; no write, no `PostingService`, no migration. Company is on EVERY query
 * (F3); a project-scoped user's `project_id IN (:assigned)` filter is applied server-side (F4); money is
 * summed in `numeric(18,4)` and serialised as decimal strings (never float). Period/as-of takes precedence
 * over a date range on balance reports (trial balance, balance sheet), exactly as LED's trial balance.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { ValidationError } from '../../common/errors/domain-error';
import { DATA_SOURCE } from '../../database/database.module';
import { getManager } from '../../infrastructure/unit-of-work/transaction-context';
import { resolvePaging } from '../../infrastructure/http/pagination';
import {
  AccountLedgerRow,
  BalanceSheetRow,
  ProjectPnlRow,
  TrialBalanceRow,
} from '../domain/report-result.model';
import { LedgerReadPort, LedgerScope, PaginatedRows } from '../domain/ports/ledger.read.port';

const GROUP_COLS: Record<string, string> = {
  account: 'account_id',
  project: 'project_id',
  cost_centre: 'cost_centre_id',
  purpose: 'purpose_id',
  godown: 'godown_id',
  party: 'party_id',
};

const PNL_GROUP_COLS: Record<string, string> = {
  project: 'project_id',
  cost_centre: 'cost_centre_id',
};

/** Cash & bank GL account codes (seed CoA: 1100 Cash, 1110 Bank) — cash/bank book population. */
const CASH_BANK_CODES = "'1100','1110'";

interface Cond {
  conds: string[];
  params: unknown[];
}

@Injectable()
export class LedgerReadAdapter implements LedgerReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  // ── shared scoped WHERE over journal_line l ⋈ journal_entry e ────────────────────────────────────
  private cond(scope: LedgerScope, opts: { balanceMode: boolean }): Cond {
    const params: unknown[] = [scope.companyId];
    const conds = ['e.company_id = $1'];
    const push = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.financialYearId) push('e.financial_year_id = $$', scope.financialYearId);
    // As-of / period takes precedence over the date range on balance reports (mirrors LED trial balance).
    if (opts.balanceMode && scope.periodId) {
      push('e.voucher_date <= (SELECT end_date FROM accounting_period WHERE id = $$)', scope.periodId);
    } else if (opts.balanceMode && scope.asOf) {
      push('e.voucher_date <= $$', scope.asOf);
    } else {
      if (scope.dateFrom) push('e.voucher_date >= $$', scope.dateFrom);
      if (scope.dateTo) push('e.voucher_date <= $$', scope.dateTo);
    }
    if (scope.voucherType) push('e.voucher_type = $$', scope.voucherType);
    if (scope.accountId) push('l.account_id = $$', scope.accountId);
    if (scope.costCentreId) push('l.cost_centre_id = $$', scope.costCentreId);
    if (scope.purposeId) push('l.purpose_id = $$', scope.purposeId);
    if (scope.godownId) push('l.godown_id = $$', scope.godownId);
    if (scope.partyId) push('l.party_id = $$', scope.partyId);
    const pc = this.projectClause(scope, params, 'l');
    if (pc) conds.push(pc);
    return { conds, params };
  }

  /** F4 project filter: null → all; [] → none (WHERE false, valid empty report); [ids] → ANY(:assigned). */
  private projectClause(scope: LedgerScope, params: unknown[], alias: string): string | null {
    if (scope.projectIds === null) return null;
    if (scope.projectIds.length === 0) return 'false';
    params.push(scope.projectIds);
    return `${alias}.project_id = ANY($${params.length}::uuid[])`;
  }

  // ── trial balance (FR-RPT-009) ─────────────────────────────────────────────────────────────────
  async trialBalance(
    scope: LedgerScope,
  ): Promise<{ rows: TrialBalanceRow[]; totals: { debit: string; credit: string } }> {
    const groupTokens = (scope.groupBy ?? 'account').split(',').map((t) => t.trim()).filter(Boolean);
    for (const t of groupTokens) {
      if (!GROUP_COLS[t]) throw new ValidationError(`Unknown groupBy token '${t}'`, { token: t });
    }
    const groupExpr = groupTokens.map((t) => `l.${GROUP_COLS[t]}`).join(', ');
    const { conds, params } = this.cond(scope, { balanceMode: true });
    const where = conds.join(' AND ');
    const from = 'FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id';

    const rows = await this.manager().query(
      `SELECT ${groupExpr},
              SUM(l.debit)::numeric(18,4)::text AS debit,
              SUM(l.credit)::numeric(18,4)::text AS credit,
              (SUM(l.debit) - SUM(l.credit))::numeric(18,4)::text AS net
         ${from} WHERE ${where} GROUP BY ${groupExpr} ORDER BY ${groupExpr}`,
      params,
    );
    const [tot] = await this.manager().query(
      `SELECT COALESCE(SUM(l.debit),0)::numeric(18,4)::text AS debit,
              COALESCE(SUM(l.credit),0)::numeric(18,4)::text AS credit ${from} WHERE ${where}`,
      params,
    );
    return {
      rows: rows.map((r: Record<string, string | null>) => ({
        accountId: (r.account_id as string) ?? null,
        projectId: (r.project_id as string) ?? null,
        costCentreId: (r.cost_centre_id as string) ?? null,
        purposeId: (r.purpose_id as string) ?? null,
        godownId: (r.godown_id as string) ?? null,
        partyId: (r.party_id as string) ?? null,
        debit: r.debit as string,
        credit: r.credit as string,
        net: r.net as string,
      })),
      totals: { debit: tot.debit, credit: tot.credit },
    };
  }

  // ── account ledger (FR-RPT-010) ────────────────────────────────────────────────────────────────
  accountLedger(scope: LedgerScope): Promise<PaginatedRows<AccountLedgerRow>> {
    return this.runningLedger(scope, null);
  }

  // ── cash / bank book (FR-RPT-012) — account-ledger restricted to cash/bank accounts ─────────────
  cashBankBook(scope: LedgerScope): Promise<PaginatedRows<AccountLedgerRow>> {
    const extra = scope.accountId
      ? null
      : `l.account_id IN (SELECT id FROM account WHERE company_id = $1 AND code IN (${CASH_BANK_CODES}))`;
    return this.runningLedger(scope, extra);
  }

  /** Shared opening-balance + cross-page running-balance ledger read (account-ledger / cash-bank-book). */
  private async runningLedger(
    scope: LedgerScope,
    extraCond: string | null,
  ): Promise<PaginatedRows<AccountLedgerRow>> {
    const m = this.manager();
    const { conds, params } = this.cond(scope, { balanceMode: false });
    if (extraCond) conds.push(extraCond);
    const where = conds.join(' AND ');
    const join = 'FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id';

    // Opening balance = Σ(debit − credit) on the account(s) BEFORE dateFrom (0 if no lower bound).
    let openingBalance = '0.0000';
    if (scope.dateFrom) {
      const op = this.cond(
        { ...scope, dateFrom: undefined, dateTo: undefined, periodId: undefined, asOf: undefined },
        { balanceMode: false },
      );
      if (extraCond) op.conds.push(extraCond);
      op.params.push(scope.dateFrom);
      op.conds.push(`e.voucher_date < $${op.params.length}`);
      const [openRow] = await m.query(
        `SELECT COALESCE(SUM(l.debit - l.credit),0)::numeric(18,4)::text AS opening ${join} WHERE ${op.conds.join(' AND ')}`,
        op.params,
      );
      openingBalance = openRow.opening;
    }

    const [{ count }] = await m.query(`SELECT count(*)::text AS count ${join} WHERE ${where}`, params);
    const total = parseInt(count, 10);

    const { skip, take } = resolvePaging(scope);
    // openingBalance is a trusted numeric::text from our own query — inline as a single-quoted literal.
    const runningExpr = `, ('${openingBalance}'::numeric(18,4) + SUM(l.debit - l.credit) OVER (ORDER BY e.voucher_date, e.entry_no, l.line_no ROWS UNBOUNDED PRECEDING))::numeric(18,4)::text AS running_balance`;
    const rows = await m.query(
      `SELECT * FROM (
         ${this.lineSelect(runningExpr)} WHERE ${where}
       ) sub ORDER BY voucher_date ASC, entry_no ASC, line_no ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return { items: rows.map((r: Record<string, unknown>) => this.toLedgerRow(r, true)), total, openingBalance };
  }

  // ── daybook (FR-RPT-011) ───────────────────────────────────────────────────────────────────────
  async daybook(scope: LedgerScope): Promise<PaginatedRows<AccountLedgerRow>> {
    const m = this.manager();
    const { conds, params } = this.cond(scope, { balanceMode: false });
    const where = conds.join(' AND ');
    const join = 'FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id';

    const [{ count }] = await m.query(`SELECT count(*)::text AS count ${join} WHERE ${where}`, params);
    const total = parseInt(count, 10);

    const { skip, take } = resolvePaging(scope);
    const rows = await m.query(
      `${this.lineSelect()} WHERE ${where}
       ORDER BY e.voucher_date ASC, e.entry_no ASC, l.line_no ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return { items: rows.map((r: Record<string, unknown>) => this.toLedgerRow(r, false)), total };
  }

  // ── profit & loss (FR-RPT-013) ─────────────────────────────────────────────────────────────────
  async profitAndLoss(
    scope: LedgerScope,
  ): Promise<{ rows: ProjectPnlRow[]; totals: { revenue: string; cost: string; profit: string } }> {
    const groupTokens = (scope.groupBy ?? 'project').split(',').map((t) => t.trim()).filter(Boolean);
    for (const t of groupTokens) {
      if (!PNL_GROUP_COLS[t]) throw new ValidationError(`Unknown groupBy token '${t}'`, { token: t });
    }
    const groupExpr = groupTokens.map((t) => `l.${PNL_GROUP_COLS[t]}`).join(', ');
    const { conds, params } = this.cond(scope, { balanceMode: false });
    conds.push("a.type IN ('INCOME','EXPENSE')");
    const where = conds.join(' AND ');
    const from =
      'FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id JOIN account a ON a.id = l.account_id';
    const REV = "SUM(CASE WHEN a.type = 'INCOME' THEN l.credit - l.debit ELSE 0 END)";
    const COST = "SUM(CASE WHEN a.type = 'EXPENSE' THEN l.debit - l.credit ELSE 0 END)";

    const rows = await this.manager().query(
      `SELECT ${groupExpr},
              ${REV}::numeric(18,4)::text AS revenue,
              ${COST}::numeric(18,4)::text AS cost,
              (${REV} - ${COST})::numeric(18,4)::text AS profit
         ${from} WHERE ${where} GROUP BY ${groupExpr} ORDER BY ${groupExpr}`,
      params,
    );
    const [tot] = await this.manager().query(
      `SELECT COALESCE(${REV},0)::numeric(18,4)::text AS revenue,
              COALESCE(${COST},0)::numeric(18,4)::text AS cost,
              (COALESCE(${REV},0) - COALESCE(${COST},0))::numeric(18,4)::text AS profit
         ${from} WHERE ${where}`,
      params,
    );
    return {
      rows: rows.map((r: Record<string, string | null>) => ({
        projectId: (r.project_id as string) ?? null,
        costCentreId: (r.cost_centre_id as string) ?? null,
        revenue: r.revenue as string,
        cost: r.cost as string,
        profit: r.profit as string,
      })),
      totals: { revenue: tot.revenue, cost: tot.cost, profit: tot.profit },
    };
  }

  // ── balance sheet (FR-RPT-014) ─────────────────────────────────────────────────────────────────
  async balanceSheet(
    scope: LedgerScope,
  ): Promise<{ rows: BalanceSheetRow[]; totals: { assets: string; liabilities: string; equity: string } }> {
    const m = this.manager();
    const { conds, params } = this.cond(scope, { balanceMode: true });
    conds.push("a.type IN ('ASSET','LIABILITY','EQUITY')");
    const where = conds.join(' AND ');

    const groupRows = await m.query(
      `SELECT g.id AS gid, g.name AS gname, g.type AS gtype,
              SUM(CASE WHEN g.type = 'ASSET' THEN l.debit - l.credit ELSE l.credit - l.debit END)::numeric(18,4)::text AS balance
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.journal_entry_id
         JOIN account a ON a.id = l.account_id
         JOIN account_group g ON g.id = a.account_group_id
        WHERE ${where}
        GROUP BY g.id, g.name, g.type
        ORDER BY g.type, g.name`,
      params,
    );

    // Current-period earnings (revenue − cost as-of the same scope) close into equity so that
    // assets = liabilities + equity holds by construction (the full ledger balances). FR-RPT-014.
    const ni = this.cond(scope, { balanceMode: true });
    ni.conds.push("a.type IN ('INCOME','EXPENSE')");
    const [niRow] = await m.query(
      `SELECT COALESCE(SUM(CASE WHEN a.type = 'INCOME' THEN l.credit - l.debit ELSE 0 END),0)::numeric(18,4)::text AS revenue,
              COALESCE(SUM(CASE WHEN a.type = 'EXPENSE' THEN l.debit - l.credit ELSE 0 END),0)::numeric(18,4)::text AS cost
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.journal_entry_id
         JOIN account a ON a.id = l.account_id
        WHERE ${ni.conds.join(' AND ')}`,
      ni.params,
    );
    const netIncome = new Decimal(niRow.revenue).minus(niRow.cost);

    let assets = new Decimal(0);
    let liabilities = new Decimal(0);
    let equityBase = new Decimal(0);
    const rows: BalanceSheetRow[] = groupRows.map((r: Record<string, string>) => {
      const bal = new Decimal(r.balance);
      if (r.gtype === 'ASSET') assets = assets.plus(bal);
      else if (r.gtype === 'LIABILITY') liabilities = liabilities.plus(bal);
      else equityBase = equityBase.plus(bal);
      return {
        accountGroupId: r.gid,
        accountGroup: r.gname,
        accountType: r.gtype,
        balance: bal.toFixed(4),
        projectId: null,
      };
    });
    rows.push({
      accountGroupId: null,
      accountGroup: 'Current Period Earnings',
      accountType: 'EQUITY',
      balance: netIncome.toFixed(4),
      projectId: null,
    });
    const equity = equityBase.plus(netIncome);
    return {
      rows,
      totals: { assets: assets.toFixed(4), liabilities: liabilities.toFixed(4), equity: equity.toFixed(4) },
    };
  }

  // ── row helpers ────────────────────────────────────────────────────────────────────────────────
  private lineSelect(extra = ''): string {
    return `SELECT l.id, l.line_no, l.account_id, l.project_id, l.cost_centre_id, l.purpose_id,
                   l.godown_id, l.party_id, l.debit::text AS debit, l.credit::text AS credit, l.narration,
                   e.id AS entry_id, e.entry_no, e.voucher_type,
                   to_char(e.voucher_date,'YYYY-MM-DD') AS voucher_date, e.source_type, e.source_id${extra}
              FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id`;
  }

  private toLedgerRow(r: Record<string, unknown>, withRunning: boolean): AccountLedgerRow {
    const row: AccountLedgerRow = {
      entryId: r.entry_id as string,
      entryNo: r.entry_no as string,
      voucherType: r.voucher_type as string,
      voucherDate: r.voucher_date as string,
      sourceType: r.source_type as string,
      sourceId: r.source_id as string,
      accountId: r.account_id as string,
      projectId: (r.project_id as string) ?? null,
      costCentreId: (r.cost_centre_id as string) ?? null,
      purposeId: (r.purpose_id as string) ?? null,
      godownId: (r.godown_id as string) ?? null,
      partyId: (r.party_id as string) ?? null,
      debit: r.debit as string,
      credit: r.credit as string,
      narration: (r.narration as string) ?? null,
    };
    if (withRunning && r.running_balance !== undefined) {
      row.runningBalance = r.running_balance as string;
    }
    return row;
  }
}
