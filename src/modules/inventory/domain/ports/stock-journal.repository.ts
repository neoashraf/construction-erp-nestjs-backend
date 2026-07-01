/**
 * StockJournalRepository port (INV owns; adapter in infrastructure). PURE interface, mirrors
 * `journal-voucher.repository.ts`'s shape (insert/save/find/findByIdForUpdate, companyId-scoped,
 * optimistic-lock aware via `save(voucher, expectedVersion)`). `findByIdForUpdate` row-locks the draft
 * at post (anti-double-post, design §2.5).
 */
import { StockJournal } from '../stock-journal';

export interface StockJournalListFilter {
  status?: string; // csv
  mode?: string; // csv
  projectId?: string;
  godownId?: string; // matches either from- or to-godown
  itemId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface StockJournalRepository {
  insert(journal: StockJournal): Promise<void>;
  save(journal: StockJournal, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<StockJournal | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<StockJournal | null>;
  softDelete(id: string, companyId: string): Promise<void>;
}

export const STOCK_JOURNAL_REPOSITORY = Symbol('StockJournalRepository');
