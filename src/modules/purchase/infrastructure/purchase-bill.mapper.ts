/**
 * PurchaseBillMapper (INFRASTRUCTURE) — translates the pure PurchaseBill (+lines) aggregate <-> its ORM
 * rows. The domain never imports TypeORM; this is the only seam. Money/qty <-> Decimal is exact via the
 * ORM transformer.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../common/money';
import {
  PurchaseBill,
  PurchaseBillLineProps,
  PurchaseBillProps,
  PurchaseBillStatus,
} from '../domain/purchase-bill';
import { PurchaseBillLineOrmEntity } from './purchase-bill-line.orm-entity';
import { PurchaseBillOrmEntity } from './purchase-bill.orm-entity';

export const PurchaseBillMapper = {
  toOrm(bill: PurchaseBill): PurchaseBillOrmEntity {
    const p = bill.props;
    const e = new PurchaseBillOrmEntity();
    e.id = bill.id;
    e.companyId = p.companyId;
    e.financialYearId = p.financialYearId;
    e.projectId = p.projectId;
    e.supplierId = p.supplierId;
    e.purchaseOrderId = p.purchaseOrderId;
    e.supplierInvoiceRef = p.supplierInvoiceRef;
    e.billDate = p.billDate;
    e.dueDate = p.dueDate;
    e.grossAmount = p.grossAmount.amount;
    e.vatInputAmount = p.vatInputAmount.amount;
    e.tdsAmount = p.tdsAmount.amount;
    e.aitAmount = p.aitAmount.amount;
    e.netPayableAmount = p.netPayableAmount.amount;
    e.narration = p.narration;
    e.status = p.status;
    e.entryNo = p.entryNo;
    e.journalEntryId = p.journalEntryId;
    e.postedAt = p.postedAt;
    e.postedBy = p.postedBy;
    e.deletedAt = null;
    return e;
  },

  lineToOrm(purchaseBillId: string, l: PurchaseBillLineProps): PurchaseBillLineOrmEntity {
    const e = new PurchaseBillLineOrmEntity();
    e.id = l.id;
    e.purchaseBillId = purchaseBillId;
    e.lineNo = l.lineNo;
    e.itemId = l.itemId;
    e.expenseAccountId = l.expenseAccountId;
    e.isStockLine = l.isStockLine;
    e.billedQty = l.billedQty;
    e.rate = l.rate;
    e.lineAmount = l.lineAmount;
    e.vatInputAmount = l.vatInputAmount;
    e.tdsAmount = l.tdsAmount;
    e.aitAmount = l.aitAmount;
    e.godownId = l.godownId;
    e.projectId = l.projectId;
    e.costCentreId = l.costCentreId;
    e.purposeId = l.purposeId;
    e.receivedQty = l.receivedQty;
    return e;
  },

  toDomain(row: PurchaseBillOrmEntity, lines: PurchaseBillLineOrmEntity[]): PurchaseBill {
    const props: PurchaseBillProps = {
      companyId: row.companyId,
      financialYearId: row.financialYearId,
      projectId: row.projectId,
      supplierId: row.supplierId,
      purchaseOrderId: row.purchaseOrderId,
      supplierInvoiceRef: row.supplierInvoiceRef,
      billDate: row.billDate,
      dueDate: row.dueDate,
      grossAmount: Money.of(new Decimal(row.grossAmount)),
      vatInputAmount: Money.of(new Decimal(row.vatInputAmount)),
      tdsAmount: Money.of(new Decimal(row.tdsAmount)),
      aitAmount: Money.of(new Decimal(row.aitAmount)),
      netPayableAmount: Money.of(new Decimal(row.netPayableAmount)),
      narration: row.narration,
      status: row.status as PurchaseBillStatus,
      entryNo: row.entryNo,
      journalEntryId: row.journalEntryId,
      postedAt: row.postedAt,
      postedBy: row.postedBy,
      version: row.version,
    };
    const lineProps: PurchaseBillLineProps[] = lines
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        itemId: l.itemId,
        expenseAccountId: l.expenseAccountId,
        isStockLine: l.isStockLine,
        billedQty: new Decimal(l.billedQty),
        rate: new Decimal(l.rate),
        lineAmount: new Decimal(l.lineAmount),
        vatInputAmount: new Decimal(l.vatInputAmount),
        tdsAmount: new Decimal(l.tdsAmount),
        aitAmount: new Decimal(l.aitAmount),
        godownId: l.godownId,
        projectId: l.projectId,
        costCentreId: l.costCentreId,
        purposeId: l.purposeId,
        receivedQty: new Decimal(l.receivedQty),
      }));
    return PurchaseBill.rehydrate(row.id, props, lineProps);
  },
};
