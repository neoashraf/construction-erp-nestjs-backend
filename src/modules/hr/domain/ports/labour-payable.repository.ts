/**
 * LabourPayableRepository port (HR-owned, driven). PURE interface. Persist/load the LabourPayable rollup
 * written alongside the accrual (FR-HR-011); every method is companyId-scoped (F3). `findByAccrualEntry`
 * lets the PAY-event consumer locate the payable to roll up settlement (settled_amount/status) without
 * re-posting.
 */
import { LabourPayable } from '../labour-payable';

export interface LabourPayableRepository {
  insert(payable: LabourPayable): Promise<void>;
  save(payable: LabourPayable, expectedVersion: number): Promise<void>;
  findByAccrualEntry(companyId: string, accrualEntryId: string): Promise<LabourPayable | null>;
}

export const LABOUR_PAYABLE_REPOSITORY = Symbol('LabourPayableRepository');
