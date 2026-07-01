/**
 * IpcMapper (INFRASTRUCTURE) — translates the pure Ipc aggregate ↔ the `sales_invoice` ORM row. The
 * domain never imports TypeORM; this is the only seam. Money ↔ Decimal is exact via the ORM transformer.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../common/money';
import { Ipc, IpcStatus } from '../domain/ipc';
import { IpcOrmEntity } from './ipc.orm-entity';

export const IpcMapper = {
  toOrm(ipc: Ipc): IpcOrmEntity {
    const p = ipc.props;
    const e = new IpcOrmEntity();
    e.id = ipc.id;
    e.companyId = p.companyId;
    e.financialYearId = p.financialYearId;
    e.projectId = p.projectId;
    e.customerId = p.customerId;
    e.ipcSeqNo = p.ipcSeqNo;
    e.ipcDate = p.ipcDate;
    e.billDate = p.billDate;
    e.dueDate = p.dueDate;
    e.workCompletedPct = p.workCompletedPct;
    e.certifiedAmount = p.certifiedAmount.amount;
    e.costCentreId = p.costCentreId;
    e.purposeId = p.purposeId;
    e.outputVatAmount = p.outputVatAmount.amount;
    e.aitTdsAmount = p.aitTdsAmount.amount;
    e.retentionAmount = p.retentionAmount.amount;
    e.advanceRecoveredAmount = p.advanceRecoveredAmount.amount;
    e.currentlyDueAmount = p.currentlyDueAmount.amount;
    e.retentionRatePct = p.retentionRatePct;
    e.advanceRatePct = p.advanceRatePct;
    e.narration = p.narration;
    e.status = p.status;
    e.entryNo = p.entryNo;
    e.journalEntryId = p.journalEntryId;
    e.postedAt = p.postedAt;
    e.postedBy = p.postedBy;
    e.deletedAt = null;
    return e;
  },

  toDomain(r: IpcOrmEntity): Ipc {
    return Ipc.rehydrate(r.id, {
      companyId: r.companyId,
      financialYearId: r.financialYearId,
      projectId: r.projectId,
      customerId: r.customerId,
      ipcSeqNo: r.ipcSeqNo,
      ipcDate: r.ipcDate,
      billDate: r.billDate,
      dueDate: r.dueDate,
      workCompletedPct: new Decimal(r.workCompletedPct),
      certifiedAmount: Money.of(new Decimal(r.certifiedAmount)),
      costCentreId: r.costCentreId,
      purposeId: r.purposeId,
      outputVatAmount: Money.of(new Decimal(r.outputVatAmount)),
      aitTdsAmount: Money.of(new Decimal(r.aitTdsAmount)),
      retentionAmount: Money.of(new Decimal(r.retentionAmount)),
      advanceRecoveredAmount: Money.of(new Decimal(r.advanceRecoveredAmount)),
      currentlyDueAmount: Money.of(new Decimal(r.currentlyDueAmount)),
      retentionRatePct: new Decimal(r.retentionRatePct),
      advanceRatePct: new Decimal(r.advanceRatePct),
      narration: r.narration,
      status: r.status as IpcStatus,
      entryNo: r.entryNo,
      journalEntryId: r.journalEntryId,
      postedAt: r.postedAt,
      postedBy: r.postedBy,
      version: r.version,
    });
  },
};
