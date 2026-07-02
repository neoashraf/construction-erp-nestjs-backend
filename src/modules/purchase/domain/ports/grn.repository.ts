/**
 * GrnRepository port (PUR-owned, driven). PURE interface — the application depends on this, the TypeORM
 * adapter implements it. Persist/load the Grn aggregate; `findByIdForUpdate` row-locks the draft inside
 * the post/cancel UoW (anti-double-post). `receivedSoFar` is the Σ received quantity across POSTED GRNs
 * per bill line — the input to the match-status snapshot and the partial-receipt open balance
 * (FR-PUR-017, FR-PUR-018; design §2.5). Every method is companyId-scoped (F3).
 */
import Decimal from 'decimal.js';
import { Grn } from '../grn';

export interface GrnListFilter {
  projectId?: string;
  supplierId?: string;
  purchaseBillId?: string;
  purchaseOrderId?: string;
  status?: string; // csv of DRAFT,POSTED,CANCELLED
  dateFrom?: string; // receiptDate
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface GrnRepository {
  insert(grn: Grn): Promise<void>;
  save(grn: Grn, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<Grn | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<Grn | null>;
  /** Σ received_qty of POSTED GRN lines referencing this purchase_bill_line (FR-PUR-018). */
  receivedSoFar(purchaseBillLineId: string, companyId: string): Promise<Decimal>;
}

export const GRN_REPOSITORY = Symbol('GrnRepository');
