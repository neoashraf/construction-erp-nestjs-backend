/**
 * PurchaseAccountMapPort (MAS seam, driven). PURE interface. Resolves the `PurchaseAccountMap` a company's
 * bill posts through (VAT-input/AP/TDS/AIT well-known-code accounts, incl. `inventoryOf` which delegates
 * to INV's `InventoryAccountResolver` — see `purchase-account-map.adapter.ts`, architectural decision 2).
 */
import { PurchaseAccountMap } from '../bill-posting';

export interface PurchaseAccountMapPort {
  resolve(companyId: string): Promise<PurchaseAccountMap>;
}

export const PURCHASE_ACCOUNT_MAP_PORT = Symbol('PurchaseAccountMapPort');
