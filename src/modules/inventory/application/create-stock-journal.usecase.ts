/**
 * CreateStockJournalUseCase — save a Stock Journal DRAFT (no stock moves, no ledger impact, no number —
 * FR-INV-012, -022). Inside one uow.run:
 *   1. build the pure `StockJournal` aggregate (mode/side rules, qty>0 — FR-INV-008, edge 2);
 *   2. CC `TagConsistencyService.assertConsistent` — each side's purpose/godown must belong to its
 *      project (FR-CC-004 → CROSS_PROJECT_DIMENSION), mirroring `create-requisition.usecase.ts`'s usage;
 *   3. insert + audit.
 * Design §5.1.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import {
  TAG_CONSISTENCY_SERVICE,
  TagConsistencyService,
} from '../../../core/cost-control/domain/ports/tag-consistency.port';
import { NewStockJournal, StockJournal } from '../domain/stock-journal';
import { STOCK_JOURNAL_REPOSITORY, StockJournalRepository } from '../domain/ports/stock-journal.repository';

export type CreateStockJournalInput = NewStockJournal;

@Injectable()
export class CreateStockJournalUseCase {
  constructor(
    @Inject(STOCK_JOURNAL_REPOSITORY) private readonly repo: StockJournalRepository,
    @Inject(TAG_CONSISTENCY_SERVICE) private readonly tagConsistency: TagConsistencyService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateStockJournalInput, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      const journal = StockJournal.createDraft(this.ids.next(), actor.companyId, actor.financialYearId, input);

      // CC FR-CC-004 — each side's purpose/godown must belong to that side's project.
      await this.tagConsistency.assertConsistent(
        { companyId: actor.companyId },
        journal.toLines().map((l) => ({
          projectId: l.props.projectId,
          purposeId: l.props.purposeId,
          godownId: l.props.godownId,
        })),
      );

      await this.repo.insert(journal);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'StockJournal',
        entityId: journal.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: journal.id };
    });
  }
}
