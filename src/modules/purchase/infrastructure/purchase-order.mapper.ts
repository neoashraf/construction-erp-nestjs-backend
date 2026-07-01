/**
 * PurchaseOrderMapper (INFRASTRUCTURE) — translates the pure PurchaseOrder (+lines) aggregate <-> its ORM
 * rows. The domain never imports TypeORM; this is the only seam. Money/qty <-> Decimal is exact via the
 * ORM transformer.
 */
import Decimal from 'decimal.js';
import {
  PurchaseOrder,
  PurchaseOrderLineProps,
  PurchaseOrderProps,
} from '../domain/purchase-order';
import { PurchaseOrderLineOrmEntity } from './purchase-order-line.orm-entity';
import { PurchaseOrderOrmEntity } from './purchase-order.orm-entity';

export const PurchaseOrderMapper = {
  toOrm(po: PurchaseOrder): PurchaseOrderOrmEntity {
    const p = po.props;
    const e = new PurchaseOrderOrmEntity();
    e.id = po.id;
    e.companyId = p.companyId;
    e.financialYearId = p.financialYearId;
    e.projectId = p.projectId;
    e.supplierId = p.supplierId;
    e.poRefNo = p.poRefNo;
    e.poDate = p.poDate;
    e.expectedDeliveryDate = p.expectedDeliveryDate;
    e.status = p.status;
    e.narration = p.narration;
    e.approvedBy = p.approvedBy;
    e.approvedAt = p.approvedAt;
    return e;
  },

  lineToOrm(purchaseOrderId: string, l: PurchaseOrderLineProps): PurchaseOrderLineOrmEntity {
    const e = new PurchaseOrderLineOrmEntity();
    e.id = l.id;
    e.purchaseOrderId = purchaseOrderId;
    e.lineNo = l.lineNo;
    e.itemId = l.itemId;
    e.orderedQty = l.orderedQty;
    e.rate = l.rate;
    e.lineAmount = l.lineAmount;
    e.godownId = l.godownId;
    e.projectId = l.projectId;
    e.costCentreId = l.costCentreId;
    e.purposeId = l.purposeId;
    e.billedQty = l.billedQty;
    e.receivedQty = l.receivedQty;
    return e;
  },

  toDomain(row: PurchaseOrderOrmEntity, lines: PurchaseOrderLineOrmEntity[]): PurchaseOrder {
    const props: PurchaseOrderProps = {
      companyId: row.companyId,
      financialYearId: row.financialYearId,
      projectId: row.projectId,
      supplierId: row.supplierId,
      poRefNo: row.poRefNo,
      poDate: row.poDate,
      expectedDeliveryDate: row.expectedDeliveryDate,
      status: row.status as PurchaseOrderProps['status'],
      narration: row.narration,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt,
      version: row.version,
    };
    const lineProps: PurchaseOrderLineProps[] = lines
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        itemId: l.itemId,
        orderedQty: new Decimal(l.orderedQty),
        rate: new Decimal(l.rate),
        lineAmount: new Decimal(l.lineAmount),
        godownId: l.godownId,
        projectId: l.projectId,
        costCentreId: l.costCentreId,
        purposeId: l.purposeId,
        billedQty: new Decimal(l.billedQty),
        receivedQty: new Decimal(l.receivedQty),
      }));
    return PurchaseOrder.rehydrate(row.id, props, lineProps);
  },
};
