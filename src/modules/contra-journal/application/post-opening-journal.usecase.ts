/**
 * PostOpeningJournalUseCase — assemble + post the one-time go-live opening journal (design §5.2,
 * FR-GEN-009..013). Inside ONE uow.run: the `existsOpeningFor` guard (race-safe under the post tx and
 * backed by the DB partial-unique index) rejects a second opening (OPENING_ALREADY_EXISTS); the
 * assembler reads MAS opening_balance figures and returns a balanced OPENING JournalVoucher draft; it is
 * persisted, then posted through the single writer `PostingService.post`, stamped POSTED, and saved.
 * Atomic: any failure rolls everything back — no opening voucher, no entry, no consumed number.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { OpeningAlreadyExistsError } from '../domain/errors';
import {
  JOURNAL_VOUCHER_REPOSITORY,
  JournalVoucherRepository,
} from '../domain/ports/journal-voucher.repository';
import { OpeningJournalAssembler } from './opening-journal.assembler';

export interface PostOpeningInput {
  voucherDate: string;
  narration?: string | null;
}

@Injectable()
export class PostOpeningJournalUseCase {
  constructor(
    @Inject(JOURNAL_VOUCHER_REPOSITORY) private readonly repo: JournalVoucherRepository,
    private readonly assembler: OpeningJournalAssembler,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: PostOpeningInput, actor: Actor): Promise<{ id: string; entryId: string; entryNo: string }> {
    return this.uow.run(async () => {
      if (await this.repo.existsOpeningFor(actor.companyId)) {
        throw new OpeningAlreadyExistsError(actor.companyId);
      }

      const opening = await this.assembler.assemble(
        actor.companyId,
        actor.financialYearId,
        input.voucherDate,
        input.narration ?? 'Go-live opening balances',
      );
      await this.repo.insert(opening);

      const entry = await this.posting.post(opening.toPostingCommand(actor.userId));
      opening.markPosted(entry.id, entry.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(opening, opening.version);

      await this.audit.record({
        action: 'POST',
        entityType: 'JournalVoucher',
        entityId: opening.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: opening.id, entryId: entry.id, entryNo: entry.props.entryNo };
    });
  }
}
