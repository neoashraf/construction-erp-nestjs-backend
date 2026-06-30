/** Item read side — DTOs straight from SQL, company-scoped, incl. the UoM-conversion sub-resource. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { PageRequest, Paginated, resolvePaging } from '../../../../infrastructure/http/pagination';
import { ItemOrmEntity } from '../infrastructure/item.orm-entity';
import { ItemUomConversionOrmEntity } from '../infrastructure/item-uom-conversion.orm-entity';

export interface ItemDto {
  id: string;
  code: string;
  name: string;
  baseUom: string;
  hsCode: string | null;
  defaultAccountId: string;
  isActive: boolean;
  version: number;
}
export interface ItemUomConversionDto {
  id: string;
  itemId: string;
  uom: string;
  factorToBase: string;
}
export interface ItemListFilter extends PageRequest {
  isActive?: boolean;
  q?: string;
}

@Injectable()
export class ItemQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(ItemOrmEntity);
  }
  private convRepo() {
    return getManager(this.dataSource).getRepository(ItemUomConversionOrmEntity);
  }

  async list(filter: ItemListFilter, actor: Actor): Promise<Paginated<ItemDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = this.repo().createQueryBuilder('i').where('i.company_id = :companyId', { companyId: actor.companyId });
    if (filter.isActive !== undefined) qb.andWhere('i.is_active = :a', { a: filter.isActive });
    if (filter.q) qb.andWhere('(i.code ILIKE :q OR i.name ILIKE :q)', { q: `%${filter.q}%` });
    const [rows, total] = await qb.orderBy('i.code', 'ASC').skip(skip).take(take).getManyAndCount();
    return new Paginated(rows.map(toDto), page, pageSize, total);
  }

  async getById(id: string, actor: Actor): Promise<ItemDto | null> {
    const r = await this.repo().findOne({ where: { id, companyId: actor.companyId } });
    return r ? toDto(r) : null;
  }

  async listConversions(itemId: string, actor: Actor): Promise<ItemUomConversionDto[]> {
    const rows = await this.convRepo().find({
      where: { itemId, companyId: actor.companyId },
      order: { uom: 'ASC' },
    });
    return rows.map(toConvDto);
  }

  async getConversion(id: string, itemId: string, actor: Actor): Promise<ItemUomConversionDto | null> {
    const r = await this.convRepo().findOne({ where: { id, itemId, companyId: actor.companyId } });
    return r ? toConvDto(r) : null;
  }
}

function toDto(r: ItemOrmEntity): ItemDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    baseUom: r.baseUom,
    hsCode: r.hsCode,
    defaultAccountId: r.defaultAccountId,
    isActive: r.isActive,
    version: r.version,
  };
}
function toConvDto(r: ItemUomConversionOrmEntity): ItemUomConversionDto {
  return { id: r.id, itemId: r.itemId, uom: r.uom, factorToBase: r.factorToBase.toFixed(4) };
}
