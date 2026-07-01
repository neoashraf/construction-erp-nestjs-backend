/**
 * ReverseStockJournalUseCase — append-only correction of a POSTED Stock Journal (design §5.3, FR-INV-020).
 * Inside ONE uow.run: row-lock the voucher, assertPosted, write MIRROR movements (opposite direction,
 * restoring the prior balances — FR-INV-020) for every original movement, call
 * `posting.reverse(journalEntryId, reason)` ONLY if a ledger entry was posted (a same-account §4.2
 * transfer has none), mark the voucher CANCELLED, save, audit. LED rejects reversing into a closed
 * period/closed project (FR-INV-019, FR-LED-029).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { StockMovement } from '../domain/stock-movement';
import { STOCK_JOURNAL_REPOSITORY, StockJournalRepository } from '../domain/ports/stock-journal.repository';
import { STOCK_MOVEMENT_REPOSITORY, StockMovementRepository } from '../domain/ports/stock-movement.repository';
import { applyTransferIn, valueIssue } from '../domain/valuation';
import { STOCK_JOURNAL_SOURCE_TYPE } from './post-stock-journal.usecase';

@Injectable()
export class ReverseStockJournalUseCase {
  constructor(
    @Inject(STOCK_JOURNAL_REPOSITORY) private readonly journals: StockJournalRepository,
    @Inject(STOCK_MOVEMENT_REPOSITORY) private readonly movements: StockMovementRepository,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(id: string, reason: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const journal = await this.journals.findByIdForUpdate(id, actor.companyId);
      if (!journal) throw new NotFoundError(`Stock Journal ${id} not found`);
      journal.assertPosted();

      const now = this.clock.now();

      // Mirror each posted side — opposite of what post() did, restoring the prior balance exactly.
      for (const line of journal.toLines()) {
        if (line.props.rate == null || line.props.value == null) continue; // defensive; posted lines always have these
        const prev = await this.movements.currentBalanceForUpdate(
          actor.companyId,
          line.props.godownId,
          line.props.itemId,
        );
        if (line.props.side === 'OUT') {
          // The original took stock OUT; the mirror puts it back IN at the same rate/value.
          const restored = applyTransferIn(prev, line.props.quantity, line.props.value);
          const mirror = StockMovement.create(
            {
              companyId: actor.companyId,
              godownId: line.props.godownId,
              itemId: line.props.itemId,
              sourceType: STOCK_JOURNAL_SOURCE_TYPE,
              sourceId: journal.id,
              direction: 'IN',
              quantity: line.props.quantity,
              rate: line.props.rate,
              value: line.props.value,
              balanceAfter: restored,
              isReversal: true,
              voucherDate: journal.props.voucherDate,
              postedBy: actor.userId,
            },
            this.ids.next(),
            now,
          );
          await this.movements.append(mirror);
        } else {
          // The original brought stock IN; the mirror takes it back OUT at the same value.
          const { newBalance } = valueIssue(prev, line.props.quantity, { allowNegative: true });
          const mirror = StockMovement.create(
            {
              companyId: actor.companyId,
              godownId: line.props.godownId,
              itemId: line.props.itemId,
              sourceType: STOCK_JOURNAL_SOURCE_TYPE,
              sourceId: journal.id,
              direction: 'OUT',
              quantity: line.props.quantity,
              rate: line.props.rate,
              value: line.props.value,
              balanceAfter: newBalance,
              isReversal: true,
              voucherDate: journal.props.voucherDate,
              postedBy: actor.userId,
            },
            this.ids.next(),
            now,
          );
          await this.movements.append(mirror);
        }
      }

      if (journal.props.journalEntryId) {
        await this.posting.reverse(journal.props.journalEntryId, actor.companyId, reason, actor.userId);
      }

      journal.markCancelled();
      await this.journals.save(journal, journal.version);
      await this.audit.record({
        action: 'CANCEL',
        entityType: 'StockJournal',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
