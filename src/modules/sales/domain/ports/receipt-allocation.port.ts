/**
 * ReceiptAllocationPort — driven port (REC, read). SAL never redefines the Receipt entity (ADR-0001 #7) —
 * the adapter reads REC's `receipt_allocation` VIEW directly (REC exports no repository/service; mirrors
 * MasAccountClassificationAdapter's cross-module read pattern, and REC's own IpcReferenceAdapter reading
 * SAL's IpcOrmEntity the same way in the opposite direction). `receipt_allocation` selects posted,
 * non-reversed IPC-linked receipts as `(ipc_id, receipt_id, amount_applied)` (REC migration
 * 1700001600000-CreateReceipt) — a reversal/cancellation of a receipt drops it out automatically, so
 * `appliedToIpc` reflects the restoration on the next read with nothing to unwind (design §5.3).
 */
import { Money } from '../../../../common/money';

export interface ReceiptAllocationPort {
  /** Σ(amount_applied) of POSTED, non-reversed receipts referencing this IPC — REC's receipt_allocation view. */
  appliedToIpc(ipcId: string, companyId: string): Promise<Money>;
}

export const RECEIPT_ALLOCATION_PORT = Symbol('ReceiptAllocationPort');
