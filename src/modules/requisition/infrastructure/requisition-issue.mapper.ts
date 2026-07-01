/**
 * RequisitionIssueMapper (INFRASTRUCTURE) — translates the pure RequisitionIssue (+lines) aggregate ↔ its
 * ORM rows. The domain never imports TypeORM; this is the only seam. Money/qty ↔ Decimal is exact via the
 * ORM transformer.
 */
import Decimal from 'decimal.js';
import { RequisitionIssue, RequisitionIssueLineProps, RequisitionIssueProps } from '../domain/requisition-issue';
import { RequisitionIssueLineOrmEntity } from './requisition-issue-line.orm-entity';
import { RequisitionIssueOrmEntity } from './requisition-issue.orm-entity';

export const RequisitionIssueMapper = {
  toOrm(issue: RequisitionIssue): RequisitionIssueOrmEntity {
    const p = issue.props;
    const e = new RequisitionIssueOrmEntity();
    e.id = issue.id;
    e.requisitionId = p.requisitionId;
    e.issueNo = p.issueNo;
    e.fromGodownId = p.fromGodownId;
    e.journalEntryId = p.journalEntryId;
    e.entryNo = p.entryNo;
    e.issuedValue = p.issuedValue;
    e.issuedById = p.issuedById;
    e.issuedAt = p.issuedAt;
    e.negativeStockAuthorisedById = p.negativeStockAuthorisedById;
    e.reversedAt = p.reversedAt;
    e.reversedById = p.reversedById;
    return e;
  },

  lineToOrm(requisitionIssueId: string, l: RequisitionIssueLineProps): RequisitionIssueLineOrmEntity {
    const e = new RequisitionIssueLineOrmEntity();
    e.id = l.id;
    e.requisitionIssueId = requisitionIssueId;
    e.requisitionLineId = l.requisitionLineId;
    e.itemId = l.itemId;
    e.godownId = l.godownId;
    e.stockMovementId = l.stockMovementId;
    e.issuedQuantity = l.issuedQuantity;
    e.rate = l.rate;
    e.value = l.value;
    return e;
  },

  toDomain(row: RequisitionIssueOrmEntity, lines: RequisitionIssueLineOrmEntity[]): RequisitionIssue {
    const props: RequisitionIssueProps = {
      requisitionId: row.requisitionId,
      issueNo: row.issueNo,
      fromGodownId: row.fromGodownId,
      journalEntryId: row.journalEntryId,
      entryNo: row.entryNo,
      issuedValue: new Decimal(row.issuedValue),
      issuedById: row.issuedById,
      issuedAt: row.issuedAt,
      negativeStockAuthorisedById: row.negativeStockAuthorisedById,
      reversedAt: row.reversedAt,
      reversedById: row.reversedById,
    };
    const lineProps: RequisitionIssueLineProps[] = lines.map((l) => ({
      id: l.id,
      requisitionIssueId: l.requisitionIssueId,
      requisitionLineId: l.requisitionLineId,
      itemId: l.itemId,
      godownId: l.godownId,
      stockMovementId: l.stockMovementId,
      issuedQuantity: new Decimal(l.issuedQuantity),
      rate: new Decimal(l.rate),
      value: new Decimal(l.value),
    }));
    return RequisitionIssue.rehydrate(row.id, props, lineProps);
  },
};
