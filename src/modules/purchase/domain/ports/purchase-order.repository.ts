/**
 * PurchaseOrderRepository port (PUR-owned, driven). PURE interface. Persist/load the PurchaseOrder
 * aggregate; `findByIdForUpdate` row-locks the PO inside a mutating UoW (approve, or the bill-post's
 * applyBilledQty update — anti-concurrent-approve/bill). `openLines` exposes the PO's open (unbilled)
 * lines for bill/GRN defaulting (FR-PUR-003). Every method is companyId-scoped (F3).
 */
import { PurchaseOrder, PurchaseOrderLineProps } from '../purchase-order';

export interface PurchaseOrderListFilter {
  projectId?: string;
  supplierId?: string;
  status?: string; // csv enum
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface PurchaseOrderRepository {
  insert(po: PurchaseOrder): Promise<void>;
  save(po: PurchaseOrder, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<PurchaseOrder | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<PurchaseOrder | null>;
  openLines(poId: string, companyId: string): Promise<PurchaseOrderLineProps[]>;
}

export const PURCHASE_ORDER_REPOSITORY = Symbol('PurchaseOrderRepository');
