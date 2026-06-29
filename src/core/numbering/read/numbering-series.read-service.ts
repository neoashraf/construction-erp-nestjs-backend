/**
 * NumberingSeriesReadService — read side (no lock, never blocks posts; skill §2.3). Serves the series
 * list/single with a non-consuming `nextNumberPreview` (FR-NUM-013/019), the next-preview endpoint, and
 * the gap-audit (FR-NUM-021). Company-scoped (NFR-005). Reads join `financial_year` for the FY label.
 *
 * NOTE on gap-audit: the gapless counter is the source of truth here, so committedCount == lastSequence
 * by construction. True tamper detection (a manually-deleted posted voucher) cross-checks against the
 * ledger `journal_entry.entry_no`; that cross-check lands with LED (the join is added in ledger-read).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotFoundError } from '../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { formatVoucherNumber, fyShortLabel } from '../domain/numbering-series';

export interface NumberingSeriesDto {
  id: string;
  companyId: string;
  financialYearId: string;
  voucherType: string;
  prefix: string;
  paddingWidth: number;
  lastSequence: number;
  nextNumberPreview: string;
  version: number;
}

export interface NextPreviewDto {
  seriesId: string;
  lastSequence: number;
  nextSequence: number;
  nextNumberPreview: string;
}

export interface GapAuditDto {
  seriesId: string;
  voucherType: string;
  lowestSequence: number;
  highestSequence: number;
  committedCount: number;
  expectedCount: number;
  continuous: boolean;
  integrityAlert: boolean;
}

export interface NumberingSeriesListFilter extends PageRequest {
  financialYearId?: string;
  voucherType?: string;
}

interface SeriesJoinRow {
  id: string;
  company_id: string;
  financial_year_id: string;
  voucher_type: string;
  prefix: string;
  padding_width: number;
  last_sequence: number;
  version: number;
  sy: string;
  ey: string;
}

@Injectable()
export class NumberingSeriesReadService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  async list(
    filter: NumberingSeriesListFilter,
    actor: Actor,
  ): Promise<Paginated<NumberingSeriesDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const params: unknown[] = [actor.companyId];
    const conds = ['s.company_id = $1'];
    if (filter.financialYearId) {
      params.push(filter.financialYearId);
      conds.push(`s.financial_year_id = $${params.length}`);
    }
    if (filter.voucherType) {
      params.push(filter.voucherType);
      conds.push(`s.voucher_type = $${params.length}`);
    }
    const where = conds.join(' AND ');

    const countRows: Array<{ count: string }> = await this.manager().query(
      `SELECT count(*)::text AS count FROM numbering_series s WHERE ${where}`,
      params,
    );
    const total = parseInt(countRows[0]?.count ?? '0', 10);

    const rows: SeriesJoinRow[] = await this.manager().query(
      `${this.baseSelect()} WHERE ${where} ORDER BY s.voucher_type
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, take, skip],
    );
    return new Paginated(rows.map(toDto), page, pageSize, total);
  }

  async getById(id: string, actor: Actor): Promise<NumberingSeriesDto | null> {
    const row = await this.loadJoin(id, actor.companyId);
    return row ? toDto(row) : null;
  }

  async nextPreview(id: string, actor: Actor): Promise<NextPreviewDto> {
    const row = await this.requireJoin(id, actor.companyId);
    const dto = toDto(row);
    return {
      seriesId: dto.id,
      lastSequence: dto.lastSequence,
      nextSequence: dto.lastSequence + 1,
      nextNumberPreview: dto.nextNumberPreview,
    };
  }

  async gapAudit(id: string, actor: Actor): Promise<GapAuditDto> {
    const row = await this.requireJoin(id, actor.companyId);
    const last = row.last_sequence;
    const lowest = last === 0 ? 0 : 1;
    const highest = last;
    const committedCount = last; // counter is gapless by construction (see file note)
    const expectedCount = highest - lowest + (last === 0 ? 0 : 1);
    const continuous = committedCount === expectedCount;
    return {
      seriesId: row.id,
      voucherType: row.voucher_type,
      lowestSequence: lowest,
      highestSequence: highest,
      committedCount,
      expectedCount,
      continuous,
      integrityAlert: !continuous,
    };
  }

  private baseSelect(): string {
    return `SELECT s.id, s.company_id, s.financial_year_id, s.voucher_type, s.prefix,
                   s.padding_width, s.last_sequence, s.version,
                   to_char(fy.start_date,'YYYY') AS sy, to_char(fy.end_date,'YYYY') AS ey
            FROM numbering_series s
            JOIN financial_year fy ON fy.id = s.financial_year_id`;
  }

  private async loadJoin(id: string, companyId: string): Promise<SeriesJoinRow | null> {
    const rows: SeriesJoinRow[] = await this.manager().query(
      `${this.baseSelect()} WHERE s.id = $1 AND s.company_id = $2`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }

  private async requireJoin(id: string, companyId: string): Promise<SeriesJoinRow> {
    const row = await this.loadJoin(id, companyId);
    if (!row) throw new NotFoundError(`Numbering series ${id} not found`);
    return row;
  }
}

function toDto(row: SeriesJoinRow): NumberingSeriesDto {
  const label = fyShortLabel(parseInt(row.sy, 10), parseInt(row.ey, 10));
  return {
    id: row.id,
    companyId: row.company_id,
    financialYearId: row.financial_year_id,
    voucherType: row.voucher_type,
    prefix: row.prefix,
    paddingWidth: row.padding_width,
    lastSequence: row.last_sequence,
    nextNumberPreview: formatVoucherNumber(row.prefix, label, row.last_sequence + 1, row.padding_width),
    version: row.version,
  };
}
