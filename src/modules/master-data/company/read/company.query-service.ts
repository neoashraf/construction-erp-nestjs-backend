/**
 * CompanyQueryService — read side (skill §2.3): DTOs straight from SQL, no aggregates. Company is the
 * tenant root, so reads are scoped to the actor's own company id (FR-MAS-001): the list returns the
 * single company the actor belongs to, and get-by-id 404s for any other id (no cross-tenant read).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CompanyOrmEntity } from '../infrastructure/persistence/company.orm-entity';
import { PaginatedResult } from '../../read/pagination';

/** Response shape — snake_case JSON per the platform API convention (api-contracts/01-master-data.md). */
export interface CompanyDto {
  id: string;
  name: string;
  legal_name: string;
  bin: string;
  tin: string;
  address: string | null;
  currency: string;
  date_format: string;
  locale: string;
  is_active: boolean;
  version: number;
}

@Injectable()
export class CompanyQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(CompanyOrmEntity);
  }

  /** The actor's own company, as a one-item paginated list (Phase-1 single-company UI). */
  async list(actor: Actor): Promise<PaginatedResult<CompanyDto>> {
    const row = await this.repo().findOne({ where: { id: actor.companyId } });
    const data = row ? [toDto(row)] : [];
    return { data, page: 1, pageSize: data.length, total: data.length };
  }

  /** Get a company by id, scoped to the actor's company; null → 404 in the controller. */
  async getById(id: string, actor: Actor): Promise<CompanyDto | null> {
    if (id !== actor.companyId) return null;
    const row = await this.repo().findOne({ where: { id } });
    return row ? toDto(row) : null;
  }
}

function toDto(row: CompanyOrmEntity): CompanyDto {
  return {
    id: row.id,
    name: row.name,
    legal_name: row.legalName,
    bin: row.bin,
    tin: row.tin,
    address: row.address,
    currency: row.currency,
    date_format: row.dateFormat,
    locale: row.locale,
    is_active: row.isActive,
    version: row.version,
  };
}
