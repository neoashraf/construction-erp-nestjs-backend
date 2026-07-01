/**
 * RejectRequisitionUseCase — reject a SUBMITTED requisition with a mandatory reason (FR-REQ-008, edge 7).
 * Inside one uow.run: row-lock → assertSubmitted → authority (same tier check as approve — escalate-by-
 * default) → record a REJECTED RequisitionApproval (reason required → MISSING_REJECT_REASON) → REJECTED →
 * save. Then notify the requester after commit (FR-REQ-007). Moves NO stock, posts NOTHING.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { canApprove } from '../domain/approval-policy';
import { ApprovalBeyondAuthorityError } from '../domain/errors';
import {
  REQUISITION_REPOSITORY,
  RequisitionRepository,
} from '../domain/ports/requisition.repository';
import {
  APPROVAL_THRESHOLD_READ_PORT,
  ApprovalThresholdReadPort,
} from '../domain/ports/approval-threshold.read.port';
import { NOTIFICATION_PORT, NotificationPort } from '../domain/ports/notification.port';
import { approverContextOf } from './approver-context';

@Injectable()
export class RejectRequisitionUseCase {
  constructor(
    @Inject(REQUISITION_REPOSITORY) private readonly repo: RequisitionRepository,
    @Inject(APPROVAL_THRESHOLD_READ_PORT) private readonly thresholds: ApprovalThresholdReadPort,
    @Inject(NOTIFICATION_PORT) private readonly notify: NotificationPort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(id: string, reason: string, actor: Actor): Promise<void> {
    const projectId = await this.uow.run(async () => {
      const req = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!req) throw new NotFoundError(`Requisition ${id} not found`);
      req.assertSubmitted();

      const selectedTier = req.props.approvalTier ?? 'ACCOUNTS';
      if (!canApprove(selectedTier, approverContextOf(actor, req.props.projectId))) {
        throw new ApprovalBeyondAuthorityError(selectedTier);
      }

      const threshold = await this.thresholds.pmThreshold(actor.companyId);
      req.reject(
        {
          id: this.ids.next(),
          decision: 'REJECTED',
          tier: selectedTier,
          thresholdEvaluated: threshold,
          estimatedValue: req.props.estimatedValue,
          reason,
          decidedBy: actor.userId,
        },
        this.clock.now(),
      );
      await this.repo.save(req, req.version);
      await this.audit.record({
        action: 'REJECT',
        entityType: 'Requisition',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return req.props.projectId;
    });

    await this.notify.notify({
      event: 'REQUISITION_REJECTED',
      requisitionId: id,
      companyId: actor.companyId,
      projectId,
      recipients: ['REQUESTER'],
    });
  }
}
