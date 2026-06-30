/**
 * Item use-case tests with in-memory fakes (no DB) — the guards that need orchestration:
 *   - cross-company default account rejected (CROSS_COMPANY_REFERENCE, FR-MAS-027/028);
 *   - base_uom immutable once UoM conversions / stock references exist (BASE_UOM_IMMUTABLE, FR-MAS-034);
 *   - UoM conversion upsert collapses (create then update on the same (item, uom)) (FR-MAS-026).
 */
import { CreateItemUseCase, UpdateItemUseCase, UpsertItemUomConversionUseCase } from '../../../src/modules/master-data/item/application/item.use-cases';
import { Item } from '../../../src/modules/master-data/item/domain/item';
import { ItemUomConversion } from '../../../src/modules/master-data/item/domain/item-uom-conversion';
import { TypeOrmItemRepository } from '../../../src/modules/master-data/item/infrastructure/typeorm-item.repository';
import { TypeOrmItemUomConversionRepository } from '../../../src/modules/master-data/item/infrastructure/typeorm-item-uom-conversion.repository';
import { TypeOrmAccountRepository } from '../../../src/modules/master-data/chart-of-accounts/infrastructure/typeorm-account.repository';
import { BaseUomImmutableError, CrossCompanyReferenceError } from '../../../src/common/errors/domain-error';
import { AuditEntry, AuditService } from '../../../src/core/audit/application/audit.port';
import { UnitOfWork } from '../../../src/common/ports/unit-of-work.port';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const passthroughUow: UnitOfWork = { run: (work) => work() };
const actor: Actor = { userId: 'u-1', companyId: 'co-1', financialYearId: '', role: 'Admin' };

class FakeAudit implements AuditService {
  entries: AuditEntry[] = [];
  record(e: AuditEntry): Promise<void> {
    this.entries.push(e);
    return Promise.resolve();
  }
}
const accountsRepo = (exists: boolean): TypeOrmAccountRepository =>
  ({ existsInCompany: () => Promise.resolve(exists) }) as unknown as TypeOrmAccountRepository;

class FakeItemRepo {
  store = new Map<string, Item>();
  hasRefs = false;
  findById(id: string): Promise<Item | null> {
    const i = this.store.get(id);
    return Promise.resolve(i ? Item.rehydrate(i.id, { ...i.props }) : null);
  }
  insert(i: Item): Promise<void> {
    this.store.set(i.id, i);
    return Promise.resolve();
  }
  update(i: Item): Promise<void> {
    this.store.set(i.id, i);
    return Promise.resolve();
  }
  hasBaseUomReferences(): Promise<boolean> {
    return Promise.resolve(this.hasRefs);
  }
}

describe('Item use cases', () => {
  const seedItem = (repo: FakeItemRepo) =>
    repo.store.set('item-1', Item.rehydrate('item-1', { companyId: 'co-1', code: 'CEM', name: 'Cement', baseUom: 'BAG', hsCode: null, defaultAccountId: 'acc-1', isActive: true, version: 1 }));

  it('rejects a default account from another company on create (CROSS_COMPANY_REFERENCE)', async () => {
    const repo = new FakeItemRepo();
    const uc = new CreateItemUseCase(repo as unknown as TypeOrmItemRepository, accountsRepo(false), new FakeAudit(), passthroughUow, { next: () => 'item-1' });
    await expect(
      uc.execute({ code: 'CEM', name: 'Cement', baseUom: 'BAG', defaultAccountId: 'acc-x' }, actor),
    ).rejects.toBeInstanceOf(CrossCompanyReferenceError);
  });

  it('rejects a base_uom change once conversions/stock references exist (BASE_UOM_IMMUTABLE, FR-MAS-034)', async () => {
    const repo = new FakeItemRepo();
    seedItem(repo);
    repo.hasRefs = true;
    const uc = new UpdateItemUseCase(repo as unknown as TypeOrmItemRepository, accountsRepo(true), new FakeAudit(), passthroughUow);
    await expect(uc.execute('item-1', { baseUom: 'KG' }, 1, actor)).rejects.toBeInstanceOf(BaseUomImmutableError);
    expect(repo.store.get('item-1')?.props.baseUom).toBe('BAG'); // unchanged
  });

  it('allows a base_uom change while no conversions/stock references exist', async () => {
    const repo = new FakeItemRepo();
    seedItem(repo);
    repo.hasRefs = false;
    const uc = new UpdateItemUseCase(repo as unknown as TypeOrmItemRepository, accountsRepo(true), new FakeAudit(), passthroughUow);
    await uc.execute('item-1', { baseUom: 'KG' }, 1, actor);
    expect(repo.store.get('item-1')?.props.baseUom).toBe('KG');
  });
});

class FakeConversionRepo {
  store = new Map<string, ItemUomConversion>();
  private key(itemId: string, uom: string) {
    return `${itemId}:${uom}`;
  }
  findByItemAndUom(itemId: string, uom: string): Promise<ItemUomConversion | null> {
    return Promise.resolve(this.store.get(this.key(itemId, uom)) ?? null);
  }
  insert(c: ItemUomConversion): Promise<void> {
    this.store.set(this.key(c.props.itemId, c.props.uom), c);
    return Promise.resolve();
  }
  update(c: ItemUomConversion): Promise<void> {
    this.store.set(this.key(c.props.itemId, c.props.uom), c);
    return Promise.resolve();
  }
}

describe('UpsertItemUomConversionUseCase', () => {
  it('creates then collapses to an update on the same (item, uom) (FR-MAS-026)', async () => {
    const items = new FakeItemRepo();
    items.store.set('item-1', Item.rehydrate('item-1', { companyId: 'co-1', code: 'CEM', name: 'Cement', baseUom: 'BAG', hsCode: null, defaultAccountId: 'acc-1', isActive: true, version: 1 }));
    const conv = new FakeConversionRepo();
    let n = 0;
    const ids: IdGenerator = { next: () => `conv-${++n}` };
    const uc = new UpsertItemUomConversionUseCase(items as unknown as TypeOrmItemRepository, conv as unknown as TypeOrmItemUomConversionRepository, new FakeAudit(), passthroughUow, ids);

    const a = await uc.execute('item-1', { uom: 'TON', factorToBase: '1000' }, actor);
    const b = await uc.execute('item-1', { uom: 'TON', factorToBase: '1200' }, actor);
    expect(b.id).toBe(a.id); // same row — upsert collapsed
    expect(conv.store.size).toBe(1);
    expect(conv.store.get('item-1:TON')?.props.factorToBase.toFixed(4)).toBe('1200.0000');
  });
});
