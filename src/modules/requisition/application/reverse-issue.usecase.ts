/**
 * ReverseIssueUseCase — correct a posted requisition issue (append-only; design §5.3, FR-REQ-017). Inside
 * ONE uow.run:
 *   1. row-lock the requisition header (findByIdForUpdate);
 *   2. load the issue, assertNotReversed() — a second reverse -> AlreadyReversedIssueError (edge 12);
 *   3. per issue line: inventory.reverseIssueOut(...) — INV writes a mirror IN movement restoring the
 *      godown balance by the EXACT stored qty/value (no re-valuation), under its own (godown,item) lock;
 *   4. posting.reverse(journalEntryId, ...) — LED reversal entry (period/project guards re-apply, FR-LED-029);
 *   5. req.reverseIssue(...) — restores the affected lines' issued/balance, recomputes status
 *      (ISSUED -> PARTIALLY_ISSUED, or PARTIALLY_ISSUED -> APPROVED if all issues reversed) (FR-REQ-017);
 *   6. issue.markReversed(...) + save the requisition + the issue reversal mark — all in the ONE uow.run.
 * The original movement/entry/issue rows are never edited (append-only correction).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import {
  REQUISITION_REPOSITORY,
  RequisitionRepository,
} from '../domain/ports/requisition.repository';
import { REQ_INVENTORY_SERVICE } from '../domain/ports/inventory.service.port';
import type { InventoryService } from '../domain/ports/inventory.service.port';
import { NOTIFICATION_PORT, NotificationPort } from '../domain/ports/notification.port';

export interface ReverseIssueResult {
  requisitionStatus: string;
  projectId: string;
}

@Injectable()
export class ReverseIssueUseCase {
  constructor(
    @Inject(REQUISITION_REPOSITORY) private readonly repo: RequisitionRepository,
    @Inject(REQ_INVENTORY_SERVICE) private readonly inventory: InventoryService,
    private readonly posting: PostingService,
    @Inject(NOTIFICATION_PORT) private readonly notify: NotificationPort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    requisitionId: string,
    issueId: string,
    reason: string,
    actor: Actor,
  ): Promise<ReverseIssueResult> {
    const result = await this.uow.run(async () => {
      const req = await this.repo.findByIdForUpdate(requisitionId, actor.companyId);
      if (!req) throw new NotFoundError(`Requisition ${requisitionId} not found`);

      const issue = await this.repo.findIssue(requisitionId, issueId, actor.companyId);
      if (!issue) throw new NotFoundError(`Requisition issue ${issueId} not found`);
      issue.assertNotReversed();

      const now = this.clock.now();
      const voucherDate = now.toISOString().slice(0, 10);

      for (const line of issue.lines) {
        await this.inventory.reverseIssueOut(
          { companyId: actor.companyId, voucherDate, postedBy: actor.userId },
          {
            godownId: line.godownId,
            itemId: line.itemId,
            qty: line.issuedQuantity,
            value: line.value,
            sourceId: line.id,
          },
        );
      }

      await this.posting.reverse(issue.props.journalEntryId, actor.companyId, reason, actor.userId);

      req.reverseIssue(
        issue.lines.map((l) => ({ lineId: l.requisitionLineId, issuedQuantity: l.issuedQuantity })),
      );
      issue.markReversed(actor.userId, now);

      await this.repo.save(req, req.version);
      await this.repo.saveIssueReversal(issue);
      await this.audit.record({
        action: 'CANCEL',
        entityType: 'Requisition',
        entityId: requisitionId,
        actorId: actor.userId,
        companyId: actor.companyId,
      });

      return { requisitionStatus: req.props.status, projectId: req.props.projectId };
    });

    await this.notify.notify({
      event: 'REQUISITION_ISSUE_REVERSED',
      requisitionId,
      companyId: actor.companyId,
      projectId: result.projectId,
      recipients: ['REQUESTER'],
    });

    return result;
  }
}
