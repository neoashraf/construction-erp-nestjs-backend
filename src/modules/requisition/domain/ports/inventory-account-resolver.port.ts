/**
 * REQ's InventoryAccountResolver seam (brief #23) — a THIN RE-EXPORT of INV's own port
 * (`modules/inventory/domain/ports/inventory-account-resolver.port.ts`), NOT a redefinition. The
 * consumption command REQ builds (`Dr material expense / Cr inventory`, design §4.1/§4.3) needs the SAME
 * two accounts a Stock Journal ISSUE resolves; REQ's own DI token here is bound, in `requisition.module.ts`,
 * to the SAME `InventoryAccountResolverAdapter` class INV's module provides (CLAUDE.md "one owner per
 * entity" — MAS/INV own account resolution, REQ only calls it).
 */
export type { InventoryAccountResolver } from '../../../inventory/domain/ports/inventory-account-resolver.port';

export const REQ_INVENTORY_ACCOUNT_RESOLVER = Symbol('Requisition.InventoryAccountResolver');
