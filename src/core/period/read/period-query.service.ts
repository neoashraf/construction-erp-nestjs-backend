/**
 * PeriodQueryService — read side (no lock, never blocks posts; skill §2.3). Lists periods by FY,
 * gets one by id, and the NON-throwing date→period `resolve` lookup for UI/status (FR-PER-005/006):
 * a closed/undefined period is conveyed in the body (`isOpen`/`reason`), HTTP 200 — distinct from the
 * post-time guard which throws. Company-scoped (NFR-005).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { FinancialYearNotFoundError } from '../domain/errors';
import { AccountingPeriodDto } from './period.dto';

export interface PeriodListFilter extends PageRequest {
  financialYearId: string;
  status?: 'OPEN' | 'CLOSED';
}

export interface ResolveResult {
  date: string;
  period: AccountingPeriodDto | null;
  isOpen: boolean;
  reason?: 'NO_PERIOD_DEFINED';
}

interface PeriodRow {
  id: string;
  financial_year_id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  closed_at: string | null;
  closed_by: string | null;
}

const SELECT = `SELECT id, financial_year_id, name,
       to_char(start_date,'YYYY-MM-DD') AS start_date,
       to_char(end_date,'YYYY-MM-DD') AS end_date,
       status,
       to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at,
       closed_by
  FROM accounting_period`;

@Injectable()
export class PeriodQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  async list(filter: PeriodListFilter, actor: Actor): Promise<Paginated<AccountingPeriodDto>> {
    await this.assertFyExists(actor.companyId, filter.financialYearId);
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const params: unknown[] = [actor.companyId, filter.financialYearId];
    let where = 'company_id = $1 AND financial_year_id = $2';
    if (filter.status) {
      params.push(filter.status);
      where += ` AND status = $${params.length}`;
    }
    const countRows: Array<{ count: string }> = await this.manager().query(
      `SELECT count(*)::text AS count FROM accounting_period WHERE ${where}`,
      params,
    );
    const total = parseInt(countRows[0]?.count ?? '0', 10);
    const rows: PeriodRow[] = await this.manager().query(
      `${SELECT} WHERE ${where} ORDER BY start_date ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return new Paginated(rows.map(toDto), page, pageSize, total);
  }

  async getById(id: string, actor: Actor): Promise<AccountingPeriodDto | null> {
    const rows: PeriodRow[] = await this.manager().query(
      `${SELECT} WHERE id = $1 AND company_id = $2`,
      [id, actor.companyId],
    );
    return rows[0] ? toDto(rows[0]) : null;
  }

  async resolve(financialYearId: string, date: string, actor: Actor): Promise<ResolveResult> {
    await this.assertFyExists(actor.companyId, financialYearId);
    const rows: PeriodRow[] = await this.manager().query(
      `${SELECT} WHERE company_id = $1 AND financial_year_id = $2 AND start_date <= $3 AND end_date >= $3 LIMIT 1`,
      [actor.companyId, financialYearId, date],
    );
    if (!rows[0]) return { date, period: null, isOpen: false, reason: 'NO_PERIOD_DEFINED' };
    const period = toDto(rows[0]);
    return { date, period, isOpen: period.status === 'OPEN' };
  }

  private async assertFyExists(companyId: string, financialYearId: string): Promise<void> {
    const rows: unknown[] = await this.manager().query(
      `SELECT 1 FROM financial_year WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [financialYearId, companyId],
    );
    if (rows.length === 0) throw new FinancialYearNotFoundError(financialYearId);
  }
}

function toDto(r: PeriodRow): AccountingPeriodDto {
  return {
    id: r.id,
    financialYearId: r.financial_year_id,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status as 'OPEN' | 'CLOSED',
    closedAt: r.closed_at,
    closedBy: r.closed_by,
  };
}
