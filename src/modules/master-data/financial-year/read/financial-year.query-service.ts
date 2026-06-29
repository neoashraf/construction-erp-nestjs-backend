/**
 * FinancialYearQueryService — read side (skill §2.3): DTOs straight from SQL, company-scoped
 * (NFR-005). Supports the contracted list (`?page&pageSize&isActive`) and get-by-id (FR-MAS-002/003).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { FinancialYearOrmEntity } from '../infrastructure/persistence/financial-year.orm-entity';
import { PageRequest, PaginatedResult, resolvePaging } from '../../read/pagination';

/** Response shape — snake_case JSON per the platform API convention. */
export interface FinancialYearDto {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  is_active: boolean;
  version: number;
}

export interface FinancialYearListFilter extends PageRequest {
  isActive?: boolean;
}

@Injectable()
export class FinancialYearQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(FinancialYearOrmEntity);
  }

  async list(filter: FinancialYearListFilter, actor: Actor): Promise<PaginatedResult<FinancialYearDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const where: Record<string, unknown> = { companyId: actor.companyId };
    if (filter.isActive !== undefined) where.isActive = filter.isActive;
    const [rows, total] = await this.repo().findAndCount({
      where,
      order: { startDate: 'DESC' },
      skip,
      take,
    });
    return { data: rows.map(toDto), page, pageSize, total };
  }

  async getById(id: string, actor: Actor): Promise<FinancialYearDto | null> {
    const row = await this.repo().findOne({ where: { id, companyId: actor.companyId } });
    return row ? toDto(row) : null;
  }
}

function toDto(row: FinancialYearOrmEntity): FinancialYearDto {
  return {
    id: row.id,
    label: row.label,
    start_date: row.startDate,
    end_date: row.endDate,
    is_active: row.isActive,
    version: row.version,
  };
}
