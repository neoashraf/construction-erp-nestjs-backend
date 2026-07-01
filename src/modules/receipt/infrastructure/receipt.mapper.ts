/**
 * ReceiptMapper (INFRASTRUCTURE) — translates the pure Receipt aggregate <-> the `receipt` ORM row. The
 * domain never imports TypeORM; this is the only seam. Money <-> Decimal is exact via the ORM transformer.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../common/money';
import { Receipt, ReceiptStatus, ReceiptType } from '../domain/receipt';
import { PaymentMode } from '../domain/payment-mode';
import { ReceiptOrmEntity } from './receipt.orm-entity';

export const ReceiptMapper = {
  toOrm(receipt: Receipt): ReceiptOrmEntity {
    const p = receipt.props;
    const e = new ReceiptOrmEntity();
    e.id = receipt.id;
    e.companyId = p.companyId;
    e.financialYearId = p.financialYearId;
    e.receiptType = p.receiptType;
    e.receiptDate = p.receiptDate;
    e.paymentMode = p.paymentMode;
    e.depositAccountId = p.depositAccountId;
    e.partyId = p.partyId;
    e.projectId = p.projectId;
    e.costCentreId = p.costCentreId;
    e.purposeId = p.purposeId;
    e.ipcId = p.ipcId;
    e.generalTargetAccountId = p.generalTargetAccountId;
    e.amountSettled = p.amountSettled.amount;
    e.cashReceived = p.cashReceived.amount;
    e.taxDeductedAtSource = p.taxDeductedAtSource.amount;
    e.chequeTxnRef = p.chequeTxnRef;
    e.narration = p.narration;
    e.status = p.status;
    e.entryNo = p.entryNo;
    e.journalEntryId = p.journalEntryId;
    e.postedAt = p.postedAt;
    e.postedBy = p.postedBy;
    e.deletedAt = null;
    return e;
  },

  toDomain(r: ReceiptOrmEntity): Receipt {
    return Receipt.rehydrate(r.id, {
      companyId: r.companyId,
      financialYearId: r.financialYearId,
      receiptType: r.receiptType as ReceiptType,
      receiptDate: r.receiptDate,
      paymentMode: r.paymentMode as PaymentMode,
      depositAccountId: r.depositAccountId,
      partyId: r.partyId,
      projectId: r.projectId,
      costCentreId: r.costCentreId,
      purposeId: r.purposeId,
      ipcId: r.ipcId,
      generalTargetAccountId: r.generalTargetAccountId,
      amountSettled: Money.of(new Decimal(r.amountSettled)),
      cashReceived: Money.of(new Decimal(r.cashReceived)),
      taxDeductedAtSource: Money.of(new Decimal(r.taxDeductedAtSource)),
      chequeTxnRef: r.chequeTxnRef,
      narration: r.narration,
      status: r.status as ReceiptStatus,
      entryNo: r.entryNo,
      journalEntryId: r.journalEntryId,
      postedAt: r.postedAt,
      postedBy: r.postedBy,
      version: r.version,
    });
  },
};
