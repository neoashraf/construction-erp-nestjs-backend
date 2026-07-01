/**
 * ApproveRequisitionUseCase — approve a SUBMITTED requisition (FR-REQ-008/-009/-010/-011). Inside one
 * uow.run:
 *   1. row-lock the requisition (findByIdForUpdate);
 *   2. assertSubmitted (only SUBMITTED is reviewable → REQUISITION_NOT_SUBMITTED);
 *   3. escalate-by-default authority: canApprove(selectedTier, approverContext) — a PM may approve a
 *      PM-tier requisition for an assigned project; a PM approving an ACCOUNTS-tier (escalated) or an
 *      unassigned project → APPROVAL_BEYOND_AUTHORITY (403); an undefined/exceeded limit grants no
 *      authority (FR-REQ-010/-011; overview §10);
 *   4. record a RequisitionApproval → APPROVED;
 *   5. save.
 * Then notify Store Keeper + requester after commit (FR-REQ-007). Moves NO stock, posts NOTHING.
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
export class ApproveRequisitionUseCase {
  constructor(
    @Inject(REQUISITION_REPOSITORY) private readonly repo: RequisitionRepository,
    @Inject(APPROVAL_THRESHOLD_READ_PORT) private readonly thresholds: ApprovalThresholdReadPort,
    @Inject(NOTIFICATION_PORT) private readonly notify: NotificationPort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(id: string, note: string | null, actor: Actor): Promise<void> {
    const projectId = await this.uow.run(async () => {
      const req = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!req) throw new NotFoundError(`Requisition ${id} not found`);
      req.assertSubmitted();

      const selectedTier = req.props.approvalTier ?? 'ACCOUNTS';
      if (!canApprove(selectedTier, approverContextOf(actor, req.props.projectId))) {
        throw new ApprovalBeyondAuthorityError(selectedTier);
      }

      const threshold = await this.thresholds.pmThreshold(actor.companyId);
      req.approve(
        {
          id: this.ids.next(),
          decision: 'APPROVED',
          tier: selectedTier,
          thresholdEvaluated: threshold,
          estimatedValue: req.props.estimatedValue,
          reason: note ?? null,
          decidedBy: actor.userId,
        },
        this.clock.now(),
      );
      await this.repo.save(req, req.version);
      await this.audit.record({
        action: 'APPROVE',
        entityType: 'Requisition',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return req.props.projectId;
    });

    await this.notify.notify({
      event: 'REQUISITION_APPROVED',
      requisitionId: id,
      companyId: actor.companyId,
      projectId,
      recipients: ['STORE_KEEPER', 'REQUESTER'],
    });
  }
}
