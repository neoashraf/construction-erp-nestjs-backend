/**
 * IpcReferencePort — driven port (SAL: posted-IPC lookup + per-IPC outstanding REC reduces). REC never
 * redefines the IPC (ADR-0001 #7) — it reads SAL's IpcOrmEntity directly (SAL/MAS export no repositories;
 * mirrors MasAccountClassificationAdapter's cross-module ORM-entity read pattern) and computes the
 * outstanding as ipc.currentlyDueAmount - Sigma(applied receipts), the same formula the receipt_allocation
 * view encodes (design §2.5, §5.3).
 */
import { Money } from '../../../../common/money';

export interface IpcRef {
  id: string;
  companyId: string;
  projectId: string;
  customerId: string;
  costCentreId: string;
  purposeId: string;
  status: string;
  currentlyDueAmount: Money;
}

export interface IpcReferencePort {
  /** The referenced IPC, scoped to the caller's company; null if not found. */
  findPostedIpc(ipcId: string, companyId: string): Promise<IpcRef | null>;
  /** SAL's outstanding formula: currentlyDue - Sigma(amountSettled) of POSTED, non-reversed receipts referencing this IPC. */
  outstandingForIpc(ipcId: string, companyId: string): Promise<Money>;
}

export const IPC_REFERENCE_PORT = Symbol('IpcReferencePort');
