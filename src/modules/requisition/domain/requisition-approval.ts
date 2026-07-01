/**
 * RequisitionApproval (PURE — no NestJS/TypeORM). An append-style audit record written once at
 * approve/reject and never changed: who reviewed, the decision, the tier that applied, the BDT threshold
 * the estimated value was compared against, the estimated value at the moment of review, the reason, and
 * the timestamp (SRS §8, FR-REQ-008). Money is exact Decimal; the aggregate collects these records and
 * the mapper persists them.
 */
import Decimal from 'decimal.js';
import { ApprovalDecision, ApprovalTier } from './requisition-status';

export interface RequisitionApprovalProps {
  id: string;
  requisitionId: string;
  decision: ApprovalDecision;
  tier: ApprovalTier;
  thresholdEvaluated: Decimal;
  estimatedValueAtReview: Decimal;
  reason: string | null;
  decidedBy: string;
  decidedAt: Date;
}

export class RequisitionApproval {
  constructor(private readonly _props: RequisitionApprovalProps) {}

  static of(props: RequisitionApprovalProps): RequisitionApproval {
    return new RequisitionApproval(props);
  }

  get props(): Readonly<RequisitionApprovalProps> {
    return this._props;
  }
}
