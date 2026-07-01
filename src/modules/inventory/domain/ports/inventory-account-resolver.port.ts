/**
 * InventoryAccountResolver port (MAS seam — architectural decision 1). PURE interface. Resolves the two
 * accounts a Stock Journal posting needs (design §2.5, §4):
 *   - `inventoryAccountOf` — the PER-ITEM inventory control account (`item.default_account_id`, MAS
 *     `Item`), company-scoped. Phase-1 schema has no per-godown account column on `Godown`, so both sides
 *     of a single-item TRANSFER resolve through the same call; a same-account transfer (§4.2) and a
 *     cross-account transfer (§4.3, proven with a fake resolver in tests) both fall out of comparing the
 *     two resolved ids.
 *   - `expenseAccountOf` — the well-known Material Expense account (CoA code `5100`), for the ISSUE
 *     posting template (§4.1).
 * Throws `InventoryAccountNotConfiguredError` when the item / its `default_account_id`, or the
 * well-known expense account, cannot be resolved.
 */
export interface InventoryAccountResolver {
  inventoryAccountOf(companyId: string, itemId: string): Promise<string>;
  expenseAccountOf(companyId: string): Promise<string>;
}

export const INVENTORY_ACCOUNT_RESOLVER = Symbol('InventoryAccountResolver');
