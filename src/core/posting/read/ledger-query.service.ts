/**
 * LedgerQueryService — LED read side (skill §2.3): DTOs straight from SQL over the one append-only
 * ledger, no aggregates. Four reads under /api/ledger (FR-LED-030/031):
 *   - entries  : paginated headers + total_debit/credit + DERIVED is_reversed / reversed_by_entry_id;
 *   - entryById: header + lines[] + reversed_by ({entry_id, entry_no} | null);
 *   - lines    : flat denormalised lines; account-ledger mode adds opening_balance + cross-page
 *                cumulative running_balance (debit-positive);
 *   - trialBalance: grouped Dr/Cr/net + totals; period_id (as-of end) precedence over date range.
 * Every read is company-scoped (NFR-005); a PM is restricted to assigned projects (AC9). Money is
 * serialised as Decimal(18,4) strings (AC10).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ValidationError } from '../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';

export interface EntriesFilter {
  page?: number;
  pageSize?: number;
  financialYearId?: string;
  periodId?: string;
  voucherType?: string;
  dateFrom?: string;
  dateTo?: string;
  sourceType?: string;
  sourceId?: string;
  entryNo?: string;
  isReversal?: boolean;
  projectId?: string;
  costCentreId?: string;
  purposeId?: string;
  godownId?: string;
  accountId?: string;
  partyId?: string;
}

export interface LedgerEntryHeaderDto {
  id: string;
  entryNo: string;
  voucherType: string;
  voucherDate: string;
  sourceType: string;
  sourceId: string;
  isReversal: boolean;
  reversalOf: string | null;
  totalDebit: string;
  totalCredit: string;
  isReversed: boolean;
  reversedByEntryId: string | null;
}

export interface LedgerLineDto {
  id: string;
  lineNo: number;
  accountId: string;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  godownId: string | null;
  partyId: string | null;
  debit: string;
  credit: string;
  narration: string | null;
  entryId: string;
  entryNo: string;
  voucherType: string;
  voucherDate: string;
  sourceType: string;
  sourceId: string;
  runningBalance?: string;
}

export interface LedgerEntryDetailDto extends LedgerEntryHeaderDto {
  narration: string | null;
  postedAt: string;
  postedBy: string;
  lines: LedgerLineDto[];
  reversedBy: { entryId: string; entryNo: string } | null;
}

export interface TrialBalanceRow {
  accountId: string | null;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  godownId: string | null;
  partyId: string | null;
  debit: string;
  credit: string;
  net: string;
}

const GROUP_COLS: Record<string, string> = {
  account: 'account_id',
  project: 'project_id',
  cost_centre: 'cost_centre_id',
  purpose: 'purpose_id',
  godown: 'godown_id',
  party: 'party_id',
};

@Injectable()
export class LedgerQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  // ---- helper: PM project-scope predicate over a line alias --------------------------------------
  private pmScopeClause(actor: Actor, params: unknown[], lineAlias: string): string | null {
    if (!actor.projectScope) return null;
    if (actor.projectScope.length === 0) {
      return 'false'; // a PM with no assigned projects sees nothing
    }
    params.push(actor.projectScope);
    return `${lineAlias}.project_id = ANY($${params.length}::uuid[])`;
  }

  // ===== entries list ============================================================================
  async entries(filter: EntriesFilter, actor: Actor): Promise<Paginated<LedgerEntryHeaderDto>> {
    if (filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo) {
      throw new ValidationError('dateFrom must be <= dateTo', { field: 'dateFrom' });
    }
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const params: unknown[] = [actor.companyId];
    const conds = ['e.company_id = $1'];
    const add = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (filter.financialYearId) add('e.financial_year_id = $$', filter.financialYearId);
    if (filter.voucherType) add('e.voucher_type = $$', filter.voucherType);
    if (filter.dateFrom) add('e.voucher_date >= $$', filter.dateFrom);
    if (filter.dateTo) add('e.voucher_date <= $$', filter.dateTo);
    if (filter.sourceType) add('e.source_type = $$', filter.sourceType);
    if (filter.sourceId) add('e.source_id = $$', filter.sourceId);
    if (filter.entryNo) add('e.entry_no = $$', filter.entryNo);
    if (filter.isReversal !== undefined) add('e.is_reversal = $$', filter.isReversal);
    if (filter.periodId) {
      params.push(filter.periodId);
      const p = `$${params.length}`;
      conds.push(
        `e.voucher_date BETWEEN (SELECT start_date FROM accounting_period WHERE id = ${p}) AND (SELECT end_date FROM accounting_period WHERE id = ${p})`,
      );
    }
    // line-level filters → EXISTS over journal_line
    const lineConds: string[] = [];
    const addLine = (col: string, val: unknown) => {
      params.push(val);
      lineConds.push(`l.${col} = $${params.length}`);
    };
    if (filter.projectId) addLine('project_id', filter.projectId);
    if (filter.costCentreId) addLine('cost_centre_id', filter.costCentreId);
    if (filter.purposeId) addLine('purpose_id', filter.purposeId);
    if (filter.godownId) addLine('godown_id', filter.godownId);
    if (filter.accountId) addLine('account_id', filter.accountId);
    if (filter.partyId) addLine('party_id', filter.partyId);
    const pm = this.pmScopeClause(actor, params, 'l');
    if (pm) lineConds.push(pm);
    if (lineConds.length > 0) {
      conds.push(`EXISTS (SELECT 1 FROM journal_line l WHERE l.journal_entry_id = e.id AND ${lineConds.join(' AND ')})`);
    }
    const where = conds.join(' AND ');

    const [{ count }] = await this.manager().query(
      `SELECT count(*)::text AS count FROM journal_entry e WHERE ${where}`,
      params,
    );
    const total = parseInt(count, 10);

    const rows = await this.manager().query(
      `SELECT e.id, e.entry_no, e.voucher_type, to_char(e.voucher_date,'YYYY-MM-DD') AS voucher_date,
              e.source_type, e.source_id, e.is_reversal, e.reversal_of,
              (SELECT COALESCE(SUM(debit),0)::numeric(18,4)::text FROM journal_line l WHERE l.journal_entry_id = e.id) AS total_debit,
              (SELECT COALESCE(SUM(credit),0)::numeric(18,4)::text FROM journal_line l WHERE l.journal_entry_id = e.id) AS total_credit,
              (SELECT rev.id FROM journal_entry rev WHERE rev.reversal_of = e.id LIMIT 1) AS reversed_by_entry_id
         FROM journal_entry e WHERE ${where}
         ORDER BY e.voucher_date ASC, e.entry_no ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return new Paginated(rows.map(toHeaderDto), page, pageSize, total);
  }

  // ===== entry by id =============================================================================
  async entryById(id: string, actor: Actor): Promise<LedgerEntryDetailDto | null> {
    const [e] = await this.manager().query(
      `SELECT e.id, e.entry_no, e.voucher_type, to_char(e.voucher_date,'YYYY-MM-DD') AS voucher_date,
              e.source_type, e.source_id, e.is_reversal, e.reversal_of, e.narration,
              to_char(e.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS posted_at, e.posted_by,
              (SELECT COALESCE(SUM(debit),0)::numeric(18,4)::text FROM journal_line l WHERE l.journal_entry_id = e.id) AS total_debit,
              (SELECT COALESCE(SUM(credit),0)::numeric(18,4)::text FROM journal_line l WHERE l.journal_entry_id = e.id) AS total_credit,
              rev.id AS reversed_by_entry_id, rev.entry_no AS reversed_by_entry_no
         FROM journal_entry e
         LEFT JOIN journal_entry rev ON rev.reversal_of = e.id
         WHERE e.id = $1 AND e.company_id = $2`,
      [id, actor.companyId],
    );
    if (!e) return null;
    if (actor.projectScope && !(await this.entryInScope(id, actor))) return null;
    const lineRows = await this.manager().query(
      `${this.lineSelect()} WHERE l.journal_entry_id = $1 ORDER BY l.line_no ASC`,
      [id],
    );
    return {
      ...toHeaderDto(e),
      narration: e.narration,
      postedAt: e.posted_at,
      postedBy: e.posted_by,
      lines: lineRows.map(toLineDto),
      reversedBy: e.reversed_by_entry_id
        ? { entryId: e.reversed_by_entry_id, entryNo: e.reversed_by_entry_no }
        : null,
    };
  }

  private async entryInScope(entryId: string, actor: Actor): Promise<boolean> {
    if (!actor.projectScope) return true;
    if (actor.projectScope.length === 0) return false;
    const rows = await this.manager().query(
      `SELECT 1 FROM journal_line l WHERE l.journal_entry_id = $1 AND l.project_id = ANY($2::uuid[]) LIMIT 1`,
      [entryId, actor.projectScope],
    );
    return rows.length > 0;
  }

  // ===== lines ===================================================================================
  async lines(filter: EntriesFilter, actor: Actor): Promise<Paginated<LedgerLineDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const params: unknown[] = [actor.companyId];
    const conds = ['e.company_id = $1'];
    const add = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (filter.financialYearId) add('e.financial_year_id = $$', filter.financialYearId);
    if (filter.voucherType) add('e.voucher_type = $$', filter.voucherType);
    if (filter.dateFrom) add('e.voucher_date >= $$', filter.dateFrom);
    if (filter.dateTo) add('e.voucher_date <= $$', filter.dateTo);
    if (filter.accountId) add('l.account_id = $$', filter.accountId);
    if (filter.projectId) add('l.project_id = $$', filter.projectId);
    if (filter.costCentreId) add('l.cost_centre_id = $$', filter.costCentreId);
    if (filter.purposeId) add('l.purpose_id = $$', filter.purposeId);
    if (filter.godownId) add('l.godown_id = $$', filter.godownId);
    if (filter.partyId) add('l.party_id = $$', filter.partyId);
    const pm = this.pmScopeClause(actor, params, 'l');
    if (pm) conds.push(pm);
    const where = conds.join(' AND ');

    const accountLedgerMode = !!filter.accountId && !!filter.dateFrom && !!filter.dateTo;
    let openingBalance: string | undefined;
    if (accountLedgerMode) {
      const op: unknown[] = [actor.companyId, filter.accountId, filter.dateFrom];
      let opWhere = 'e.company_id = $1 AND l.account_id = $2 AND e.voucher_date < $3';
      const opPm = this.pmScopeClause(actor, op, 'l');
      if (opPm) opWhere += ` AND ${opPm}`;
      const [{ opening }] = await this.manager().query(
        `SELECT COALESCE(SUM(l.debit - l.credit),0)::numeric(18,4)::text AS opening
           FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id WHERE ${opWhere}`,
        op,
      );
      openingBalance = opening;
    }

    const [{ count }] = await this.manager().query(
      `SELECT count(*)::text AS count FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id WHERE ${where}`,
      params,
    );
    const total = parseInt(count, 10);

    // openingBalance is a trusted numeric::text from our own query — inline as a single-quoted literal.
    const runningExpr = accountLedgerMode
      ? `, ('${openingBalance}'::numeric(18,4) + SUM(l.debit - l.credit) OVER (ORDER BY e.voucher_date, e.entry_no, l.line_no ROWS UNBOUNDED PRECEDING))::numeric(18,4)::text AS running_balance`
      : '';
    const rows = await this.manager().query(
      `SELECT * FROM (
         ${this.lineSelect(runningExpr)} WHERE ${where}
       ) sub ORDER BY voucher_date ASC, entry_no ASC, line_no ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return new Paginated(
      rows.map((r: Record<string, unknown>) => toLineDto(r, accountLedgerMode)),
      page,
      pageSize,
      total,
      accountLedgerMode ? { openingBalance } : undefined,
    );
  }

  // ===== trial balance ===========================================================================
  async trialBalance(
    params0: {
      page?: number;
      pageSize?: number;
      financialYearId?: string;
      periodId?: string;
      dateFrom?: string;
      dateTo?: string;
      groupBy?: string;
      includeReversals?: boolean;
      projectId?: string;
      costCentreId?: string;
    },
    actor: Actor,
  ): Promise<Paginated<TrialBalanceRow>> {
    const groupTokens = (params0.groupBy ?? 'account').split(',').map((t) => t.trim());
    for (const t of groupTokens) {
      if (!GROUP_COLS[t]) throw new ValidationError(`Unknown group_by token '${t}'`, { token: t });
    }
    const groupCols = groupTokens.map((t) => GROUP_COLS[t]);
    const { page, pageSize, skip, take } = resolvePaging(params0);

    const params: unknown[] = [actor.companyId];
    const conds = ['e.company_id = $1'];
    const add = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (params0.financialYearId) add('e.financial_year_id = $$', params0.financialYearId);
    if (params0.periodId) {
      // period_id takes precedence: balances as of the END of that period (date range ignored).
      add('e.voucher_date <= (SELECT end_date FROM accounting_period WHERE id = $$)', params0.periodId);
    } else {
      if (params0.dateFrom) add('e.voucher_date >= $$', params0.dateFrom);
      if (params0.dateTo) add('e.voucher_date <= $$', params0.dateTo);
    }
    if (params0.includeReversals === false) conds.push('e.is_reversal = false');
    if (params0.projectId) add('l.project_id = $$', params0.projectId);
    if (params0.costCentreId) add('l.cost_centre_id = $$', params0.costCentreId);
    const pm = this.pmScopeClause(actor, params, 'l');
    if (pm) conds.push(pm);
    const where = conds.join(' AND ');
    const groupExpr = groupCols.map((c) => `l.${c}`).join(', ');

    const [{ count }] = await this.manager().query(
      `SELECT count(*)::text AS count FROM (
         SELECT ${groupExpr} FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id
         WHERE ${where} GROUP BY ${groupExpr}
       ) g`,
      params,
    );
    const total = parseInt(count, 10);

    const rows = await this.manager().query(
      `SELECT ${groupExpr},
              SUM(l.debit)::numeric(18,4)::text AS debit,
              SUM(l.credit)::numeric(18,4)::text AS credit,
              (SUM(l.debit) - SUM(l.credit))::numeric(18,4)::text AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id
         WHERE ${where} GROUP BY ${groupExpr} ORDER BY ${groupExpr}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    const [{ debit, credit }] = await this.manager().query(
      `SELECT COALESCE(SUM(l.debit),0)::numeric(18,4)::text AS debit, COALESCE(SUM(l.credit),0)::numeric(18,4)::text AS credit
         FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id WHERE ${where}`,
      params,
    );
    return new Paginated(
      rows.map((r: Record<string, string | null>) => ({
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
      page,
      pageSize,
      total,
      { totals: { debit, credit } },
    );
  }

  private lineSelect(extra = ''): string {
    return `SELECT l.id, l.line_no, l.account_id, l.project_id, l.cost_centre_id, l.purpose_id,
                   l.godown_id, l.party_id, l.debit::text AS debit, l.credit::text AS credit, l.narration,
                   e.id AS entry_id, e.entry_no, e.voucher_type,
                   to_char(e.voucher_date,'YYYY-MM-DD') AS voucher_date, e.source_type, e.source_id${extra}
              FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id`;
  }
}

function toHeaderDto(r: Record<string, unknown>): LedgerEntryHeaderDto {
  return {
    id: r.id as string,
    entryNo: r.entry_no as string,
    voucherType: r.voucher_type as string,
    voucherDate: r.voucher_date as string,
    sourceType: r.source_type as string,
    sourceId: r.source_id as string,
    isReversal: r.is_reversal as boolean,
    reversalOf: (r.reversal_of as string) ?? null,
    totalDebit: r.total_debit as string,
    totalCredit: r.total_credit as string,
    isReversed: !!r.reversed_by_entry_id,
    reversedByEntryId: (r.reversed_by_entry_id as string) ?? null,
  };
}

function toLineDto(r: Record<string, unknown>, accountLedgerMode = false): LedgerLineDto {
  const dto: LedgerLineDto = {
    id: r.id as string,
    lineNo: r.line_no as number,
    accountId: r.account_id as string,
    projectId: (r.project_id as string) ?? null,
    costCentreId: (r.cost_centre_id as string) ?? null,
    purposeId: (r.purpose_id as string) ?? null,
    godownId: (r.godown_id as string) ?? null,
    partyId: (r.party_id as string) ?? null,
    debit: r.debit as string,
    credit: r.credit as string,
    narration: (r.narration as string) ?? null,
    entryId: r.entry_id as string,
    entryNo: r.entry_no as string,
    voucherType: r.voucher_type as string,
    voucherDate: r.voucher_date as string,
    sourceType: r.source_type as string,
    sourceId: r.source_id as string,
  };
  if (accountLedgerMode && r.running_balance !== undefined) {
    dto.runningBalance = r.running_balance as string;
  }
  return dto;
}
