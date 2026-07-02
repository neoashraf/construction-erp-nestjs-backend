/**
 * LedgerReadAdapter (DSH · FR-DSH-011/-017) — INFRASTRUCTURE `LedgerReadPort`. Reads LED's ledger via
 * `@Inject(DATA_SOURCE)` + `getManager` (the sanctioned cross-module read, identical to RPT's
 * LedgerReadAdapter) running the SAME canonical scoped SQL LED uses over `journal_line` ⋈ `journal_entry`:
 *   - cash / bank balance  = Σ(debit − credit) on the cash ('1100') / bank ('1110') control accounts;
 *   - net inflow           = Σ(debit − credit) on cash + bank over the [dateFrom, dateTo] window;
 *   - AR outstanding/party = Σ(debit − credit) on the '1200' A/R control by party (asset, debit-positive);
 *   - AP outstanding/party = Σ(credit − debit) on the '2100' A/P control by party (liability, credit-pos).
 * These tie to the ledger by construction and reconcile to RPT's cash-bank-book / account-ledger reports
 * (same source, FR-DSH-004). Read-only: only SELECT/aggregate; company is on EVERY query (F3); the F4
 * project filter is applied server-side; money is summed in numeric(18,4) and serialised as decimal
 * strings (never float). No write, no PostingService, no migration.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module';
import { getManager } from '../../infrastructure/unit-of-work/transaction-context';
import { CashFlowKpi, PartyOutstandingRow } from '../domain/tile.model';
import { LedgerReadPort, LedgerScope } from '../domain/ports/ledger.read.port';

/** Seed CoA control-account codes (construction-coa.seed.ts). */
const CASH_CODE = "'1100'";
const BANK_CODE = "'1110'";
const CASH_BANK_CODES = "'1100','1110'";
const AR_CODE = "'1200'"; // Accounts Receivable control
const AP_CODE = "'2100'"; // Accounts Payable control

@Injectable()
export class LedgerReadAdapter implements LedgerReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  /**
   * Shared scoped WHERE over journal_line l ⋈ journal_entry e. `dateWindow` gates the cash-flow net-flow
   * (the balances read cumulatively for the FY, so they call this with `dateWindow: false`).
   */
  private cond(scope: LedgerScope, opts: { dateWindow: boolean }): { conds: string[]; params: unknown[] } {
    const params: unknown[] = [scope.companyId];
    const conds = ['e.company_id = $1'];
    const push = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.financialYearId) push('e.financial_year_id = $$', scope.financialYearId);
    if (opts.dateWindow) {
      if (scope.dateFrom) push('e.voucher_date >= $$', scope.dateFrom);
      if (scope.dateTo) push('e.voucher_date <= $$', scope.dateTo);
    }
    // F4 project filter: null → all; [] → none (WHERE false, valid zero tile); [ids] → ANY(:assigned).
    if (scope.projectIds !== null) {
      if (scope.projectIds.length === 0) {
        conds.push('false');
      } else {
        params.push(scope.projectIds);
        conds.push(`l.project_id = ANY($${params.length}::uuid[])`);
      }
    }
    return { conds, params };
  }

  async cashFlow(scope: LedgerScope): Promise<CashFlowKpi> {
    const m = this.manager();
    const from = 'FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id';
    const inCodes = (codes: string) =>
      `l.account_id IN (SELECT id FROM account WHERE company_id = $1 AND code IN (${codes}))`;

    // Net inflow: Σ(debit − credit) on cash + bank over the window.
    const flow = this.cond(scope, { dateWindow: true });
    flow.conds.push(inCodes(CASH_BANK_CODES));
    const [flowRow] = await m.query(
      `SELECT COALESCE(SUM(l.debit - l.credit),0)::numeric(18,4)::text AS net ${from} WHERE ${flow.conds.join(
        ' AND ',
      )}`,
      flow.params,
    );

    // Cash / bank balances: cumulative Σ(debit − credit) for the FY scope (no date window).
    const balance = async (codes: string): Promise<string> => {
      const b = this.cond(scope, { dateWindow: false });
      b.conds.push(inCodes(codes));
      const [row] = await m.query(
        `SELECT COALESCE(SUM(l.debit - l.credit),0)::numeric(18,4)::text AS bal ${from} WHERE ${b.conds.join(
          ' AND ',
        )}`,
        b.params,
      );
      return row.bal as string;
    };

    return {
      netInflow: flowRow.net as string,
      cashBalance: await balance(CASH_CODE),
      bankBalance: await balance(BANK_CODE),
    };
  }

  async topReceivablesPayables(
    scope: LedgerScope,
    n: number,
  ): Promise<{ topReceivables: PartyOutstandingRow[]; topPayables: PartyOutstandingRow[] }> {
    const limit = Math.max(1, Math.floor(n));
    const [topReceivables, topPayables] = await Promise.all([
      this.byParty(scope, AR_CODE, 'debit - credit', limit),
      this.byParty(scope, AP_CODE, 'credit - debit', limit),
    ]);
    return { topReceivables, topPayables };
  }

  /**
   * Top-N party outstanding on a control account: Σ(<balanceExpr>) grouped by party, positive balances
   * only, largest first. `balanceExpr` is 'debit - credit' (A/R asset) or 'credit - debit' (A/P liability).
   */
  private async byParty(
    scope: LedgerScope,
    accountCode: string,
    balanceExpr: string,
    limit: number,
  ): Promise<PartyOutstandingRow[]> {
    const { conds, params } = this.cond(scope, { dateWindow: false });
    conds.push('l.party_id IS NOT NULL');
    conds.push(
      `l.account_id IN (SELECT id FROM account WHERE company_id = $1 AND code IN (${accountCode}))`,
    );
    const where = conds.join(' AND ');
    params.push(limit);
    const rows = await this.manager().query(
      `SELECT l.party_id, p.name AS party_name,
              SUM(${balanceExpr})::numeric(18,4)::text AS outstanding
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.journal_entry_id
         JOIN party p ON p.id = l.party_id
        WHERE ${where}
        GROUP BY l.party_id, p.name
       HAVING SUM(${balanceExpr}) > 0
        ORDER BY SUM(${balanceExpr}) DESC, p.name ASC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((r: Record<string, string>) => ({
      partyId: r.party_id,
      partyName: r.party_name,
      outstanding: r.outstanding,
    }));
  }
}
