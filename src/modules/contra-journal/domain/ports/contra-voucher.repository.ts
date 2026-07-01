/**
 * ContraVoucherRepository port (GEN owns; adapter in infrastructure). PURE interface. Every method is
 * companyId-scoped (F3). `findByIdForUpdate` row-locks the draft inside the post UoW (anti-double-post,
 * FR-LED-021). The list filter powers the company-scoped list-with-filters read (FR-GEN-020).
 */
import { ContraVoucher } from '../contra-voucher';

export interface ContraListFilter {
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  entryNo?: string;
  accountId?: string;
  page?: number;
  pageSize?: number;
}

export interface ContraVoucherRepository {
  insert(voucher: ContraVoucher): Promise<void>;
  /** Persist an existing draft/posted voucher (optimistic-locked by `version`). */
  save(voucher: ContraVoucher, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<ContraVoucher | null>;
  /** SELECT … FOR UPDATE the draft inside the caller's UoW (post/reverse). */
  findByIdForUpdate(id: string, companyId: string): Promise<ContraVoucher | null>;
  /** Soft-delete a DRAFT voucher (FR-GEN-014). */
  softDelete(id: string, companyId: string): Promise<void>;
}

export const CONTRA_VOUCHER_REPOSITORY = Symbol('ContraVoucherRepository');
