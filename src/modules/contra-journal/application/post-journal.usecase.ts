/**
 * PostJournalUseCase — post a journal DRAFT atomically (design §5.1). Same shape as PostContra: one
 * uow.run → row-lock the draft → assertPostable → build the conditionally-tagged JOURNAL command →
 * PostingService.post (period→project→tags→refs→balance→number→write) → markPosted → save → audit. LED's
 * TagMatrix RE-ENFORCES the P&L-dimension + control-party rules at post (FR-GEN-005/-007). Atomic:
 * any failure rolls everything back, no consumed number (FR-GEN-015/-016/-017).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import {
  JOURNAL_VOUCHER_REPOSITORY,
  JournalVoucherRepository,
} from '../domain/ports/journal-voucher.repository';

@Injectable()
export class PostJournalUseCase {
  constructor(
    @Inject(JOURNAL_VOUCHER_REPOSITORY) private readonly repo: JournalVoucherRepository,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<{ entryId: string; entryNo: string }> {
    return this.uow.run(async () => {
      const voucher = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!voucher) throw new NotFoundError(`Journal voucher ${id} not found`);
      voucher.assertPostable();

      const entry = await this.posting.post(voucher.toPostingCommand(actor.userId));

      voucher.markPosted(entry.id, entry.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(voucher, voucher.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'JournalVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { entryId: entry.id, entryNo: entry.props.entryNo };
    });
  }
}
