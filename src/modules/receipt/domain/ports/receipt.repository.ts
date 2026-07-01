/**
 * ReceiptRepository port (REC-owned, driven). PURE interface — the application depends on this, the
 * TypeORM adapter implements it. Persist/load the Receipt aggregate; `findByIdForUpdate` row-locks the
 * draft inside the post UoW (anti-double-post, AC8). Every method is companyId-scoped (F3).
 */
import { Receipt } from '../receipt';

export interface ReceiptListFilter {
  receiptType?: string;
  projectId?: string;
  customerId?: string;
  ipcId?: string;
  paymentMode?: string; // csv of CASH,MFS,BANK_TRANSFER,CHEQUE
  status?: string; // csv of DRAFT,POSTED,CANCELLED
  financialYearId?: string;
  dateFrom?: string;
  dateTo?: string;
  entryNo?: string;
  page?: number;
  pageSize?: number;
}

export interface ReceiptRepository {
  insert(receipt: Receipt): Promise<void>;
  save(receipt: Receipt, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<Receipt | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<Receipt | null>;
  softDelete(id: string, companyId: string): Promise<void>;
}

export const RECEIPT_REPOSITORY = Symbol('ReceiptRepository');
