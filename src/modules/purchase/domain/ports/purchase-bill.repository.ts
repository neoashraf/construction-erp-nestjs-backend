/**
 * PurchaseBillRepository port (PUR-owned, driven). PURE interface — the application depends on this, the
 * TypeORM adapter implements it. Persist/load the PurchaseBill aggregate; `findByIdForUpdate` row-locks the
 * draft inside the post/cancel/repost UoW (anti-double-post, AC11). Every method is companyId-scoped (F3).
 */
import { PurchaseBill } from '../purchase-bill';

export interface PurchaseBillListFilter {
  projectId?: string;
  supplierId?: string;
  status?: string; // csv of DRAFT,POSTED,CANCELLED
  purchaseOrderId?: string;
  financialYearId?: string;
  dateFrom?: string;
  dateTo?: string;
  entryNo?: string;
  page?: number;
  pageSize?: number;
}

export interface PurchaseBillRepository {
  insert(bill: PurchaseBill): Promise<void>;
  save(bill: PurchaseBill, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<PurchaseBill | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<PurchaseBill | null>;
  softDelete(id: string, companyId: string): Promise<void>;
}

export const PURCHASE_BILL_REPOSITORY = Symbol('PurchaseBillRepository');
