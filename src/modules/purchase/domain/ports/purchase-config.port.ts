/**
 * PurchaseConfigPort (MAS config, driven). Supplies the effective PurchaseTax (VAT-input / TDS / AIT %)
 * for a company (FR-PUR-006). PURE interface; the adapter reads company config, falling back to the
 * Phase-1 defaults (VAT input 7.5%, TDS 5%, AIT 2%, per the design §4.1 worked example) — never
 * hard-coded in the aggregate. Mirrors SAL's `IpcConfigPort` exactly.
 */
import { PurchaseTax } from '../tax';

export interface PurchaseConfigPort {
  taxRates(companyId: string): Promise<PurchaseTax>;
}

export const PURCHASE_CONFIG_PORT = Symbol('PurchaseConfigPort');
