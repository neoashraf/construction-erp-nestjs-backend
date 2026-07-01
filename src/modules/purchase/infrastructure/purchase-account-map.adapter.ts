/**
 * PurchaseAccountMapAdapter (INFRASTRUCTURE) — implements PurchaseAccountMapPort by reading MAS `account`
 * rows (company-scoped) by the well-known CoA code convention (architectural decision 3), mirroring
 * `HrAccountResolverAdapter`'s exact shape. `inventoryOf` is a THIN DELEGATE to INV's own
 * `InventoryAccountResolver` (architectural decision 2 — INV owns per-item inventory account resolution;
 * PUR re-implements nothing, `purchase.module.ts` binds this adapter's INV seam to the SAME
 * `InventoryAccountResolverAdapter` class INV's own module provides). Throws
 * `PurchaseAccountNotConfiguredError` for any missing non-inventory account — mirrors
 * `HrAccountNotConfiguredError`'s shape exactly. Enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { PurchaseAccountMap } from '../domain/bill-posting';
import { PurchaseAccountMapPort } from '../domain/ports/purchase-account-map.port';
import { PurchaseAccountNotConfiguredError } from '../domain/errors';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import {
  INVENTORY_ACCOUNT_RESOLVER,
  InventoryAccountResolver,
} from '../../inventory/domain/ports/inventory-account-resolver.port';
import { WELL_KNOWN_PURCHASE_ACCOUNTS } from './well-known-purchase-accounts';

@Injectable()
export class PurchaseAccountMapAdapter implements PurchaseAccountMapPort {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(INVENTORY_ACCOUNT_RESOLVER) private readonly inventoryAccounts: InventoryAccountResolver,
  ) {}

  async resolve(companyId: string): Promise<PurchaseAccountMap> {
    const [vatInputRecoverable, accountsPayable, tdsPayable, aitPayable] = await Promise.all([
      this.byCode(companyId, WELL_KNOWN_PURCHASE_ACCOUNTS.vatInputRecoverableCode, 'vat-input-recoverable'),
      this.byCode(companyId, WELL_KNOWN_PURCHASE_ACCOUNTS.accountsPayableCode, 'accounts-payable'),
      this.byCode(companyId, WELL_KNOWN_PURCHASE_ACCOUNTS.tdsPayableCode, 'tds-payable'),
      this.byCode(companyId, WELL_KNOWN_PURCHASE_ACCOUNTS.aitPayableCode, 'ait-payable'),
    ]);
    return {
      vatInputRecoverable,
      accountsPayable,
      tdsPayable,
      aitPayable,
      inventoryOf: (itemId: string, _godownId: string) => this.inventoryAccounts.inventoryAccountOf(companyId, itemId),
    };
  }

  private async byCode(companyId: string, code: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code } });
    if (!row) throw new PurchaseAccountNotConfiguredError(role);
    return row.id;
  }
}
