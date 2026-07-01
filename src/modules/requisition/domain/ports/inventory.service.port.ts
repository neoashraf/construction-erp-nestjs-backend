/**
 * REQ's InventoryService seam (brief #23) — a THIN RE-EXPORT of INV's own port
 * (`modules/inventory/domain/ports/inventory.service.port.ts`), NOT a redefinition. REQ depends on the
 * SAME interface INV publishes (`issueOut` for the forward issue, `reverseIssueOut` for the correction —
 * design §2.4); the DI token here is REQ's own symbol so `requisition.module.ts` can bind it to the SAME
 * `InventoryServiceAdapter` INV's own module provides, without REQ importing INV's internal DI token
 * directly. INV still owns the port's shape and the valuation logic; this file exists only for REQ's own
 * composition-root convenience (CLAUDE.md "one owner per entity" — INV owns InventoryService).
 */
export type {
  InventoryService,
  IssueOutInput,
  PostCtx,
  ReceiveInInput,
  ReverseIssueOutInput,
} from '../../../inventory/domain/ports/inventory.service.port';

export const REQ_INVENTORY_SERVICE = Symbol('Requisition.InventoryService');
