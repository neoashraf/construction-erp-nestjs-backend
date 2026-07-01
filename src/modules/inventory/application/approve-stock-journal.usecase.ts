/**
 * ApproveStockJournalUseCase — DRAFT → APPROVED (FR-INV-012/-013). Inside one uow.run:
 *   1. row-lock the draft (findByIdForUpdate);
 *   2. `AccessPolicy.assertProjectInScope(actor, journal.projectId)` — the approver may approve only for
 *      an assigned project (architectural decision 4, mirrors mas-reactivate's PM project-scope
 *      enforcement / `create-requisition.usecase.ts`'s usage);
 *   3. `journal.approve(...)` — records approvedById/approvedAt;
 *   4. save + audit.
 * Moves NO stock, posts NOTHING (design §5.1).
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { AccessPolicy, ForbiddenScopeError } from '../../../core/auth/domain/access-policy';
import { STOCK_JOURNAL_REPOSITORY, StockJournalRepository } from '../domain/ports/stock-journal.repository';

@Injectable()
export class ApproveStockJournalUseCase {
  constructor(
    @Inject(STOCK_JOURNAL_REPOSITORY) private readonly repo: StockJournalRepository,
    private readonly access: AccessPolicy,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const journal = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!journal) throw new NotFoundError(`Stock Journal ${id} not found`);

      try {
        this.access.assertProjectInScope(actor, journal.props.projectId);
      } catch (e) {
        if (e instanceof ForbiddenScopeError) throw new ForbiddenException(e.message);
        throw e;
      }

      journal.approve(actor.userId, this.clock.now());
      await this.repo.save(journal, journal.version);
      await this.audit.record({
        action: 'APPROVE',
        entityType: 'StockJournal',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
