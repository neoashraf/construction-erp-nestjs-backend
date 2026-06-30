/** TypeOrmItemRepository (INFRASTRUCTURE) — company-scoped, version-guarded; company-unique code. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DuplicateCodeError } from '../../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { isUniqueViolation, versionedUpdate } from '../../shared/repo-helpers';
import { Item } from '../domain/item';
import { ItemOrmEntity } from './item.orm-entity';
import { ItemUomConversionOrmEntity } from './item-uom-conversion.orm-entity';

@Injectable()
export class TypeOrmItemRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(ItemOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<Item | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  async insert(item: Item): Promise<void> {
    const p = item.props;
    try {
      await this.repo().insert({
        id: item.id,
        companyId: p.companyId,
        code: p.code,
        name: p.name,
        baseUom: p.baseUom,
        hsCode: p.hsCode,
        defaultAccountId: p.defaultAccountId,
        isActive: p.isActive,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateCodeError(p.code);
      throw err;
    }
  }

  async update(item: Item, expectedVersion: number): Promise<void> {
    const p = item.props;
    try {
      await versionedUpdate(this.repo(), ItemOrmEntity, item.id, p.companyId, expectedVersion, {
        name: p.name,
        baseUom: p.baseUom,
        hsCode: p.hsCode,
        defaultAccountId: p.defaultAccountId,
        isActive: p.isActive,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateCodeError(p.code);
      throw err;
    }
  }

  /**
   * True if the item has any UoM conversion (or, later, stock/transaction references) — once true the
   * `base_uom` is immutable (FR-MAS-034). Stock/transaction tables arrive with INV; this probes the
   * conversions that exist today.
   */
  async hasBaseUomReferences(itemId: string): Promise<boolean> {
    const r = await getManager(this.dataSource)
      .getRepository(ItemUomConversionOrmEntity)
      .findOne({ where: { itemId }, select: { id: true } });
    return !!r;
  }
}

function toDomain(r: ItemOrmEntity): Item {
  return Item.rehydrate(r.id, {
    companyId: r.companyId,
    code: r.code,
    name: r.name,
    baseUom: r.baseUom,
    hsCode: r.hsCode,
    defaultAccountId: r.defaultAccountId,
    isActive: r.isActive,
    version: r.version,
  });
}
