/**
 * InventoryAccountResolverAdapter (INFRASTRUCTURE) — implements InventoryAccountResolver by reading MAS
 * `item` (default_account_id) and `account` (by well-known code) rows, company-scoped (architectural
 * decision 1). Mirrors `HrAccountResolverAdapter` / `MasAccountClassificationAdapter`. Enrols in the
 * active UoW via getManager. Throws InventoryAccountNotConfiguredError when the item or its
 * default_account_id row, or the well-known expense account, cannot be resolved.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { InventoryAccountResolver } from '../domain/ports/inventory-account-resolver.port';
import { InventoryAccountNotConfiguredError } from '../domain/errors';
import { ItemOrmEntity } from '../../master-data/item/infrastructure/item.orm-entity';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { WELL_KNOWN_INVENTORY_ACCOUNTS } from './well-known-inventory-accounts';

@Injectable()
export class InventoryAccountResolverAdapter implements InventoryAccountResolver {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async inventoryAccountOf(companyId: string, itemId: string): Promise<string> {
    const item = await getManager(this.dataSource)
      .getRepository(ItemOrmEntity)
      .findOne({ where: { id: itemId, companyId } });
    if (!item || !item.defaultAccountId) {
      throw new InventoryAccountNotConfiguredError('item-inventory');
    }
    return item.defaultAccountId;
  }

  async expenseAccountOf(companyId: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code: WELL_KNOWN_INVENTORY_ACCOUNTS.materialExpenseCode } });
    if (!row) throw new InventoryAccountNotConfiguredError('material-expense');
    return row.id;
  }
}
