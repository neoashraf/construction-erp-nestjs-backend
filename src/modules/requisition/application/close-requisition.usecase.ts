/**
 * CloseRequisitionUseCase — manually close an APPROVED/PARTIALLY_ISSUED requisition with outstanding
 * balance → CLOSED, abandoning the remainder (FR-REQ-020, edge 15). Inside one uow.run: row-lock →
 * project-scope check (the requester / assigned PM) → close (NoOutstandingBalanceError when already
 * fully issued) → save. Then notify the requester after commit. Moves NO stock, posts NOTHING (an
 * un-issued balance was never on the ledger).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { AccessPolicy, ForbiddenScopeError } from '../../../core/auth/domain/access-policy';
import { ForbiddenError } from './errors';
import {
  REQUISITION_REPOSITORY,
  RequisitionRepository,
} from '../domain/ports/requisition.repository';
import { NOTIFICATION_PORT, NotificationPort } from '../domain/ports/notification.port';

@Injectable()
export class CloseRequisitionUseCase {
  constructor(
    @Inject(REQUISITION_REPOSITORY) private readonly repo: RequisitionRepository,
    @Inject(NOTIFICATION_PORT) private readonly notify: NotificationPort,
    private readonly access: AccessPolicy,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, reason: string, actor: Actor): Promise<void> {
    const projectId = await this.uow.run(async () => {
      const req = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!req) throw new NotFoundError(`Requisition ${id} not found`);
      try {
        this.access.assertProjectInScope(actor, req.props.projectId);
      } catch (e) {
        if (e instanceof ForbiddenScopeError) throw new ForbiddenError(e.message);
        throw e;
      }

      req.close(reason, this.clock.now());
      await this.repo.save(req, req.version);
      await this.audit.record({
        action: 'CANCEL',
        entityType: 'Requisition',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return req.props.projectId;
    });

    await this.notify.notify({
      event: 'REQUISITION_CLOSED',
      requisitionId: id,
      companyId: actor.companyId,
      projectId,
      recipients: ['REQUESTER'],
    });
  }
}
