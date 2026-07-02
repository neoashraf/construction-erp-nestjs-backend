/**
 * GrnMapper (INFRASTRUCTURE) — translates the pure Grn (+lines) aggregate <-> its ORM rows. The domain
 * never imports TypeORM; this is the only seam. Money/qty <-> Decimal is exact via the ORM transformer.
 */
import Decimal from 'decimal.js';
import { Grn, GrnLineProps, GrnProps, GrnStatus } from '../domain/grn';
import { MatchStatus } from '../domain/match';
import { GrnLineOrmEntity } from './grn-line.orm-entity';
import { GrnOrmEntity } from './grn.orm-entity';

export const GrnMapper = {
  toOrm(grn: Grn): GrnOrmEntity {
    const p = grn.props;
    const e = new GrnOrmEntity();
    e.id = grn.id;
    e.companyId = p.companyId;
    e.financialYearId = p.financialYearId;
    e.projectId = p.projectId;
    e.supplierId = p.supplierId;
    e.purchaseOrderId = p.purchaseOrderId;
    e.purchaseBillId = p.purchaseBillId;
    e.grnRefNo = p.grnRefNo;
    e.receiptDate = p.receiptDate;
    e.status = p.status;
    e.receivedBy = p.receivedBy;
    e.narration = p.narration;
    e.postedAt = p.postedAt;
    e.postedBy = p.postedBy;
    return e;
  },

  lineToOrm(grnId: string, l: GrnLineProps): GrnLineOrmEntity {
    const e = new GrnLineOrmEntity();
    e.id = l.id;
    e.grnId = grnId;
    e.lineNo = l.lineNo;
    e.purchaseBillLineId = l.purchaseBillLineId;
    e.itemId = l.itemId;
    e.receivedQty = l.receivedQty;
    e.rate = l.rate;
    e.receivedValue = l.receivedValue;
    e.godownId = l.godownId;
    e.projectId = l.projectId;
    e.costCentreId = l.costCentreId;
    e.purposeId = l.purposeId;
    e.matchStatus = l.matchStatus;
    return e;
  },

  toDomain(row: GrnOrmEntity, lines: GrnLineOrmEntity[]): Grn {
    const props: GrnProps = {
      companyId: row.companyId,
      financialYearId: row.financialYearId,
      projectId: row.projectId,
      supplierId: row.supplierId,
      purchaseOrderId: row.purchaseOrderId,
      purchaseBillId: row.purchaseBillId,
      grnRefNo: row.grnRefNo,
      receiptDate: row.receiptDate,
      status: row.status as GrnStatus,
      receivedBy: row.receivedBy,
      narration: row.narration,
      postedAt: row.postedAt,
      postedBy: row.postedBy,
      version: row.version,
    };
    const lineProps: GrnLineProps[] = lines
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        purchaseBillLineId: l.purchaseBillLineId,
        itemId: l.itemId,
        receivedQty: new Decimal(l.receivedQty),
        rate: new Decimal(l.rate),
        receivedValue: new Decimal(l.receivedValue),
        godownId: l.godownId,
        projectId: l.projectId,
        costCentreId: l.costCentreId,
        purposeId: l.purposeId,
        matchStatus: (l.matchStatus as MatchStatus | null) ?? null,
      }));
    return Grn.rehydrate(row.id, props, lineProps);
  },
};
