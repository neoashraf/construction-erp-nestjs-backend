/**
 * UpdateStockJournalUseCase + DeleteStockJournalUseCase — edit/delete a Stock Journal, DRAFT only
 * (FR-INV-020/-022, edge 4). A non-DRAFT edit/delete throws `StockJournalPostedImmutableError`
 * (`VOUCHER_POSTED_IMMUTABLE`). The API contract's `PATCH`/`DELETE /api/stock-journal/:id` need these;
 * the brief's §5 Outputs names the four lifecycle use cases (create/approve/post/reverse) — this file
 * completes the DRAFT-only edit/delete surface those four don't cover, following the exact shape of
 * `update-requisition-draft.usecase.ts`. Re-runs the CC tag-consistency check on the replaced lines.
 * Moves NO stock, posts NOTHING.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import {
  TAG_CONSISTENCY_SERVICE,
  TagConsistencyService,
} from '../../../core/cost-control/domain/ports/tag-consistency.port';
import { NewStockJournal } from '../domain/stock-journal';
import { STOCK_JOURNAL_REPOSITORY, StockJournalRepository } from '../domain/ports/stock-journal.repository';

export type UpdateStockJournalInput = Partial<NewStockJournal> & { version: number };

@Injectable()
export class UpdateStockJournalUseCase {
  constructor(
    @Inject(STOCK_JOURNAL_REPOSITORY) private readonly repo: StockJournalRepository,
    @Inject(TAG_CONSISTENCY_SERVICE) private readonly tagConsistency: TagConsistencyService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, patch: UpdateStockJournalInput, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const journal = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!journal) throw new NotFoundError(`Stock Journal ${id} not found`);
      if (journal.version !== patch.version) {
        throw new OptimisticLockConflictError(`StockJournal ${id} was modified concurrently`, { id });
      }

      journal.editDraft(patch);

      await this.tagConsistency.assertConsistent(
        { companyId: actor.companyId },
        journal.toLines().map((l) => ({
          projectId: l.props.projectId,
          purposeId: l.props.purposeId,
          godownId: l.props.godownId,
        })),
      );

      await this.repo.save(journal, journal.version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'StockJournal',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}

@Injectable()
export class DeleteStockJournalUseCase {
  constructor(
    @Inject(STOCK_JOURNAL_REPOSITORY) private readonly repo: StockJournalRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const journal = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!journal) throw new NotFoundError(`Stock Journal ${id} not found`);
      journal.assertEditable();
      await this.repo.softDelete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE',
        entityType: 'StockJournal',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
