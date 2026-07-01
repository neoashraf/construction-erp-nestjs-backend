/**
 * RequisitionMapper (INFRASTRUCTURE) — translates the pure Requisition aggregate (header + lines +
 * approvals) ↔ its ORM rows. The domain never imports TypeORM; this is the only seam. Money/qty ↔ Decimal
 * is exact via the ORM transformer; strings are lifted into Decimal on the way in.
 */
import Decimal from 'decimal.js';
import { Requisition, RequisitionLineProps, RequisitionProps } from '../domain/requisition';
import { RequisitionApproval } from '../domain/requisition-approval';
import { ApprovalDecision, ApprovalTier, Priority, RequisitionStatus } from '../domain/requisition-status';
import { RequisitionApprovalOrmEntity } from './requisition-approval.orm-entity';
import { RequisitionLineOrmEntity } from './requisition-line.orm-entity';
import { RequisitionOrmEntity } from './requisition.orm-entity';

export const RequisitionMapper = {
  toOrm(req: Requisition): RequisitionOrmEntity {
    const p = req.props;
    const e = new RequisitionOrmEntity();
    e.id = req.id;
    e.companyId = p.companyId;
    e.financialYearId = p.financialYearId;
    e.requisitionNo = p.requisitionNo;
    e.requisitionSeq = p.requisitionSeq;
    e.projectId = p.projectId;
    e.costCentreId = p.costCentreId;
    e.purposeId = p.purposeId;
    e.fromGodownId = p.fromGodownId;
    e.requiredDate = p.requiredDate;
    e.priority = p.priority;
    e.status = p.status;
    e.estimatedValue = p.estimatedValue;
    e.approvalTier = p.approvalTier;
    e.submittedAt = p.submittedAt;
    e.submittedById = p.submittedById;
    e.closedAt = p.closedAt;
    e.closedReason = p.closedReason;
    e.narration = p.narration;
    e.deletedAt = null;
    return e;
  },

  lineToOrm(requisitionId: string, l: RequisitionLineProps): RequisitionLineOrmEntity {
    const e = new RequisitionLineOrmEntity();
    e.id = l.id;
    e.requisitionId = requisitionId;
    e.lineNo = l.lineNo;
    e.itemId = l.itemId;
    e.requestedQuantity = l.requestedQuantity;
    e.issuedQuantity = l.issuedQuantity;
    e.balanceQuantity = l.balanceQuantity;
    e.indicativeRate = l.indicativeRate;
    e.uom = l.uom;
    return e;
  },

  approvalToOrm(a: RequisitionApproval): RequisitionApprovalOrmEntity {
    const p = a.props;
    const e = new RequisitionApprovalOrmEntity();
    e.id = p.id;
    e.requisitionId = p.requisitionId;
    e.decision = p.decision;
    e.tier = p.tier;
    e.thresholdEvaluated = p.thresholdEvaluated;
    e.estimatedValueAtReview = p.estimatedValueAtReview;
    e.reason = p.reason;
    e.decidedBy = p.decidedBy;
    e.decidedAt = p.decidedAt;
    return e;
  },

  toDomain(
    r: RequisitionOrmEntity,
    lines: RequisitionLineOrmEntity[],
    approvals: RequisitionApprovalOrmEntity[] = [],
  ): Requisition {
    const props: RequisitionProps = {
      companyId: r.companyId,
      financialYearId: r.financialYearId,
      requisitionNo: r.requisitionNo,
      requisitionSeq: r.requisitionSeq,
      projectId: r.projectId,
      costCentreId: r.costCentreId,
      purposeId: r.purposeId,
      fromGodownId: r.fromGodownId,
      requiredDate: r.requiredDate,
      priority: r.priority as Priority,
      status: r.status as RequisitionStatus,
      estimatedValue: new Decimal(r.estimatedValue),
      approvalTier: (r.approvalTier as ApprovalTier | null) ?? null,
      submittedAt: r.submittedAt,
      submittedById: r.submittedById,
      closedAt: r.closedAt,
      closedReason: r.closedReason,
      narration: r.narration,
      version: r.version,
      lines: lines
        .slice()
        .sort((a, b) => a.lineNo - b.lineNo)
        .map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          itemId: l.itemId,
          requestedQuantity: new Decimal(l.requestedQuantity),
          issuedQuantity: new Decimal(l.issuedQuantity),
          balanceQuantity: new Decimal(l.balanceQuantity),
          indicativeRate: l.indicativeRate == null ? null : new Decimal(l.indicativeRate),
          uom: l.uom,
        })),
    };
    const domainApprovals = approvals.map((a) =>
      RequisitionApproval.of({
        id: a.id,
        requisitionId: a.requisitionId,
        decision: a.decision as ApprovalDecision,
        tier: a.tier as ApprovalTier,
        thresholdEvaluated: new Decimal(a.thresholdEvaluated),
        estimatedValueAtReview: new Decimal(a.estimatedValueAtReview),
        reason: a.reason,
        decidedBy: a.decidedBy,
        decidedAt: a.decidedAt,
      }),
    );
    return Requisition.rehydrate(r.id, props, domainApprovals);
  },
};
