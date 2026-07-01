/**
 * PurchaseConfigAdapter (INFRASTRUCTURE) — implements PurchaseConfigPort. Supplies the effective
 * PurchaseTax for a company. Phase-1: MAS exposes no rate-config table yet, so this returns the Phase-1
 * defaults (VAT input 7.5% / TDS 5% / AIT 2%, per the design §4.1 worked example) — held as config
 * constants, NOT hard-coded in the aggregate. When MAS lands a company rate-config service, rebind this
 * adapter to read it; the port and the aggregate stay unchanged (FR-PUR-006). Mirrors SAL's
 * `IpcConfigAdapter` exactly.
 */
import { Injectable } from '@nestjs/common';
import { PurchaseTax } from '../domain/tax';
import { PurchaseConfigPort } from '../domain/ports/purchase-config.port';
import { DEFAULT_PURCHASE_TAX_RATES } from './well-known-purchase-accounts';

@Injectable()
export class PurchaseConfigAdapter implements PurchaseConfigPort {
  async taxRates(_companyId: string): Promise<PurchaseTax> {
    void _companyId;
    return PurchaseTax.of({
      vatInputPct: DEFAULT_PURCHASE_TAX_RATES.vatInputPct,
      tdsPct: DEFAULT_PURCHASE_TAX_RATES.tdsPct,
      aitPct: DEFAULT_PURCHASE_TAX_RATES.aitPct,
    });
  }
}
