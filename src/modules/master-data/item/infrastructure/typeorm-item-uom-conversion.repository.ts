/** TypeOrmItemUomConversionRepository (INFRASTRUCTURE) — item-scoped; upsert on (item, uom). */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { versionedUpdate } from '../../shared/repo-helpers';
import { ItemUomConversion } from '../domain/item-uom-conversion';
import { ItemUomConversionOrmEntity } from './item-uom-conversion.orm-entity';

@Injectable()
export class TypeOrmItemUomConversionRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(ItemUomConversionOrmEntity);
  }

  async findByItemAndUom(itemId: string, uom: string, companyId: string): Promise<ItemUomConversion | null> {
    const r = await this.repo().findOne({ where: { itemId, uom, companyId } });
    return r ? toDomain(r) : null;
  }

  async findById(id: string, itemId: string, companyId: string): Promise<ItemUomConversion | null> {
    const r = await this.repo().findOne({ where: { id, itemId, companyId } });
    return r ? toDomain(r) : null;
  }

  async insert(c: ItemUomConversion): Promise<void> {
    const p = c.props;
    await this.repo().insert({
      id: c.id,
      companyId: p.companyId,
      itemId: p.itemId,
      uom: p.uom,
      factorToBase: p.factorToBase,
    });
  }

  async update(c: ItemUomConversion, expectedVersion: number): Promise<void> {
    const p = c.props;
    await versionedUpdate(this.repo(), ItemUomConversionOrmEntity, c.id, p.companyId, expectedVersion, {
      factorToBase: p.factorToBase,
    });
  }

  async delete(id: string, itemId: string, companyId: string): Promise<boolean> {
    const result = await this.repo()
      .createQueryBuilder()
      .delete()
      .from(ItemUomConversionOrmEntity)
      .where('id = :id AND item_id = :itemId AND company_id = :companyId', { id, itemId, companyId })
      .execute();
    return !!result.affected;
  }
}

function toDomain(r: ItemUomConversionOrmEntity): ItemUomConversion {
  return ItemUomConversion.rehydrate(r.id, {
    companyId: r.companyId,
    itemId: r.itemId,
    uom: r.uom,
    factorToBase: r.factorToBase,
    version: r.version,
  });
}
