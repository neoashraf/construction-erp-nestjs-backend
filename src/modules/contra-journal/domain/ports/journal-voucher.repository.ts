/**
 * JournalVoucherRepository port (GEN owns; adapter in infrastructure). PURE interface. Every method is
 * companyId-scoped (F3). `existsOpeningFor` backs the one-opening-per-company guard inside the locked
 * post transaction (FR-GEN-012); the DB partial-unique index is the belt-and-suspenders backstop.
 */
import { JournalVoucher } from '../journal-voucher';

export interface JournalListFilter {
  voucherType?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  entryNo?: string;
  accountId?: string;
  partyId?: string;
  projectId?: string;
  page?: number;
  pageSize?: number;
}

export interface JournalVoucherRepository {
  insert(voucher: JournalVoucher): Promise<void>;
  save(voucher: JournalVoucher, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<JournalVoucher | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<JournalVoucher | null>;
  softDelete(id: string, companyId: string): Promise<void>;
  /** True if an OPENING voucher (not soft-deleted) already exists for the company (FR-GEN-012). */
  existsOpeningFor(companyId: string): Promise<boolean>;
}

export const JOURNAL_VOUCHER_REPOSITORY = Symbol('JournalVoucherRepository');
