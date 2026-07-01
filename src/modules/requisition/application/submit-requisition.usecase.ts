/**
 * SubmitRequisitionUseCase — submit a DRAFT for review (FR-REQ-005/-006/-009). Inside one uow.run:
 *   1. row-lock the draft (findByIdForUpdate);
 *   2. re-assert masters are still active (an item/godown deactivated since draft is rejected — edge 13);
 *   3. compute estimatedValue = Σ(requestedQty × indicativeRate) via the INV port (decimal.js, no float);
 *   4. selectTier(estimatedValue, pmThreshold) — pure policy (≤ threshold → PM, else escalate to ACCOUNTS);
 *   5. allocate a simple requisitionNo (per-company+FY, non-gapless — SRS §16), stamp submittedAt/by → SUBMITTED;
 *   6. save.
 * Then notify the tier approver after commit (FR-REQ-007). Moves NO stock, posts NOTHING.
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { selectTier } from '../domain/approval-policy';
import { LineEstimate } from '../domain/requisition';
import {
  REQUISITION_REPOSITORY,
  RequisitionRepository,
} from '../domain/ports/requisition.repository';
import {
  INDICATIVE_RATE_READ_PORT,
  IndicativeRateReadPort,
} from '../domain/ports/indicative-rate.read.port';
import {
  APPROVAL_THRESHOLD_READ_PORT,
  ApprovalThresholdReadPort,
} from '../domain/ports/approval-threshold.read.port';
import {
  REQUISITION_MASTER_REF_PORT,
  RequisitionMasterRefPort,
} from '../domain/ports/requisition-master-ref.port';
import { NOTIFICATION_PORT, NotificationPort } from '../domain/ports/notification.port';

@Injectable()
export class SubmitRequisitionUseCase {
  constructor(
    @Inject(REQUISITION_REPOSITORY) private readonly repo: RequisitionRepository,
    @Inject(INDICATIVE_RATE_READ_PORT) private readonly rates: IndicativeRateReadPort,
    @Inject(APPROVAL_THRESHOLD_READ_PORT) private readonly thresholds: ApprovalThresholdReadPort,
    @Inject(REQUISITION_MASTER_REF_PORT) private readonly masters: RequisitionMasterRefPort,
    @Inject(NOTIFICATION_PORT) private readonly notify: NotificationPort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    const projectId = await this.uow.run(async () => {
      const req = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!req) throw new NotFoundError(`Requisition ${id} not found`);

      // Re-validate masters at submit (an item/godown deactivated since draft is rejected — edge 13).
      await this.masters.assertGodownActiveInProject(
        actor.companyId,
        req.props.fromGodownId,
        req.props.projectId,
      );

      // Estimate: Σ(requestedQty × indicative rate), per line (FR-REQ-005). Exact Decimal.
      const lineEstimates: LineEstimate[] = [];
      let estimated = new Decimal(0);
      for (const line of req.props.lines) {
        await this.masters.itemBaseUom(actor.companyId, line.itemId); // active re-check
        const rate = await this.rates.currentAvgOrLastKnown(
          actor.companyId,
          req.props.fromGodownId,
          line.itemId,
        );
        lineEstimates.push({ lineId: line.id, indicativeRate: rate });
        estimated = estimated.plus(rate.times(line.requestedQuantity));
      }
      estimated = estimated.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

      const pmThreshold = await this.thresholds.pmThreshold(actor.companyId);
      const tier = selectTier(estimated, pmThreshold);

      const seq = await this.repo.nextRequisitionSeq(actor.companyId, actor.financialYearId);
      const requisitionNo = formatRequisitionNo(seq);
      req.submit(requisitionNo, seq, estimated, tier, lineEstimates, actor.userId, this.clock.now());
      await this.repo.save(req, req.version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'Requisition',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return req.props.projectId;
    });

    // After commit: notify the tier approver (FR-REQ-007).
    await this.notify.notify({
      event: 'REQUISITION_SUBMITTED',
      requisitionId: id,
      companyId: actor.companyId,
      projectId,
      recipients: ['APPROVER'],
    });
  }
}

/** A simple per-company+FY reference (non-gapless — a requisition is not a legal/VAT document; SRS §16). */
function formatRequisitionNo(seq: number): string {
  return `REQ-${String(seq).padStart(6, '0')}`;
}
