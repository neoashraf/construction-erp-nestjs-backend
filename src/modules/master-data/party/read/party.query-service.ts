/** Party read side — DTOs straight from SQL, company-scoped, role filters (skill §2.3, FR-MAS-024). */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../../infrastructure/http/pagination';
import { PartyOrmEntity } from '../infrastructure/party.orm-entity';

export interface PartyDto {
  id: string;
  name: string;
  isCustomer: boolean;
  isSupplier: boolean;
  tin: string | null;
  bin: string | null;
  address: string | null;
  phone: string;
  email: string | null;
  paymentTermsDays: number;
  openingBalance: string | null;
  isActive: boolean;
  version: number;
}
export interface PartyListFilter extends PageRequest {
  isCustomer?: boolean;
  isSupplier?: boolean;
  isActive?: boolean;
  q?: string;
}

@Injectable()
export class PartyQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(PartyOrmEntity);
  }

  async list(filter: PartyListFilter, actor: Actor): Promise<Paginated<PartyDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = this.repo().createQueryBuilder('p').where('p.company_id = :companyId', { companyId: actor.companyId });
    if (filter.isCustomer !== undefined) qb.andWhere('p.is_customer = :c', { c: filter.isCustomer });
    if (filter.isSupplier !== undefined) qb.andWhere('p.is_supplier = :s', { s: filter.isSupplier });
    if (filter.isActive !== undefined) qb.andWhere('p.is_active = :a', { a: filter.isActive });
    if (filter.q) qb.andWhere('(p.name ILIKE :q OR p.phone ILIKE :q)', { q: `%${filter.q}%` });
    const [rows, total] = await qb.orderBy('p.name', 'ASC').skip(skip).take(take).getManyAndCount();
    return new Paginated(rows.map(toDto), page, pageSize, total);
  }

  async getById(id: string, actor: Actor): Promise<PartyDto | null> {
    const r = await this.repo().findOne({ where: { id, companyId: actor.companyId } });
    return r ? toDto(r) : null;
  }
}

function toDto(r: PartyOrmEntity): PartyDto {
  return {
    id: r.id,
    name: r.name,
    isCustomer: r.isCustomer,
    isSupplier: r.isSupplier,
    tin: r.tin,
    bin: r.bin,
    address: r.address,
    phone: r.phone,
    email: r.email,
    paymentTermsDays: r.paymentTermsDays,
    openingBalance: r.openingBalance == null ? null : r.openingBalance.toFixed(4),
    isActive: r.isActive,
    version: r.version,
  };
}
