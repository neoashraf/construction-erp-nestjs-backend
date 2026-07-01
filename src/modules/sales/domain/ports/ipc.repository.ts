/**
 * IpcRepository port (SAL-owned, driven). PURE interface — the application depends on this, the TypeORM
 * adapter implements it. Persist/load the Ipc aggregate; `findByIdForUpdate` row-locks the draft inside
 * the post UoW (anti-double-post, AC8); `existsSeqNo` backs the duplicate-sequence guard (FR-SAL-014).
 * Every method is companyId-scoped (F3).
 */
import { Ipc } from '../ipc';

export interface IpcListFilter {
  projectId?: string;
  customerId?: string;
  status?: string; // csv of DRAFT,POSTED,CANCELLED
  financialYearId?: string;
  dateFrom?: string;
  dateTo?: string;
  entryNo?: string;
  page?: number;
  pageSize?: number;
}

export interface IpcRepository {
  insert(ipc: Ipc): Promise<void>;
  save(ipc: Ipc, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<Ipc | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<Ipc | null>;
  existsSeqNo(companyId: string, projectId: string, seqNo: number): Promise<boolean>;
  softDelete(id: string, companyId: string): Promise<void>;
}

export const IPC_REPOSITORY = Symbol('IpcRepository');
