/**
 * PaymentRepository port (PAY-owned, driven). PURE interface — the application depends on this, the TypeORM
 * adapter implements it. Persist/load the PaymentVoucher aggregate + its allocations; `findByIdForUpdate`
 * row-locks the draft inside the post UoW (anti-double-post). Every method is companyId-scoped.
 */
import { PaymentVoucher } from '../payment-voucher';

export interface PaymentListFilter {
  paymentMode?: string; // csv of CASH,MFS,BANK_TRANSFER,CHEQUE,RTGS
  status?: string; // csv of DRAFT,POSTED,CANCELLED
  partyId?: string;
  paymentAccountId?: string;
  projectId?: string;
  financialYearId?: string;
  dateFrom?: string;
  dateTo?: string;
  entryNo?: string;
  page?: number;
  pageSize?: number;
}

export interface PaymentRepository {
  insert(payment: PaymentVoucher): Promise<void>;
  save(payment: PaymentVoucher, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<PaymentVoucher | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<PaymentVoucher | null>;
  delete(id: string, companyId: string): Promise<void>;
}

export const PAYMENT_REPOSITORY = Symbol('PaymentRepository');
