/**
 * RequisitionRepository port (REQ-owned, driven). PURE interface — the application depends on this, the
 * TypeORM adapter implements it. Persists/loads the Requisition aggregate (header + lines + approvals);
 * `findByIdForUpdate` row-locks the requisition inside a mutating UoW (anti-double-submit/approve; brief 2
 * adds `findLineForUpdate` for the issue). Every method is companyId-scoped (F3).
 */
import { Requisition } from '../requisition';

export interface RequisitionRepository {
  insert(req: Requisition): Promise<void>;
  save(req: Requisition, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<Requisition | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<Requisition | null>;
  softDelete(id: string, companyId: string): Promise<void>;
  /** Next per-company + FY requisition sequence (a simple, non-gapless reference — SRS §16). */
  nextRequisitionSeq(companyId: string, financialYearId: string): Promise<number>;
}

export const REQUISITION_REPOSITORY = Symbol('RequisitionRepository');
