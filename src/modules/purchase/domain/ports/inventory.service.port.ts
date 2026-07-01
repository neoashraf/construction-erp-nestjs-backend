/**
 * PUR's InventoryService seam — a THIN RE-EXPORT of INV's own port
 * (`modules/inventory/domain/ports/inventory.service.port.ts`), NOT a redefinition. PUR depends on the
 * SAME interface INV publishes (`receiveIn` for the bill post, `reverseReceipt` for cancel/repost — design
 * §2.4/§2.5); the DI token here is PUR's own symbol so `purchase.module.ts` can bind it to the SAME
 * `InventoryServiceAdapter` INV's own module provides, without PUR importing INV's internal DI token
 * directly (mirrors REQ's `REQ_INVENTORY_SERVICE` re-export exactly — CLAUDE.md "one owner per entity",
 * INV owns InventoryService).
 */
export type {
  InventoryService,
  IssueOutInput,
  PostCtx,
  ReceiveInInput,
  ReverseIssueOutInput,
  ReverseReceiptInput,
} from '../../../inventory/domain/ports/inventory.service.port';

export const PURCHASE_INVENTORY_SERVICE = Symbol('Purchase.InventoryService');
