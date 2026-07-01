/**
 * PostContraUseCase — post a contra DRAFT atomically (design §5.1). Inside ONE uow.run: row-lock the
 * draft (anti-double-post), assert DRAFT, build the balanced CONTRA command, hand it to the single
 * writer `PostingService.post` (which enforces period→project→tags→refs→balance→number→write), stamp
 * the voucher POSTED with the allocated gapless number, save, audit. Any failure rolls everything back —
 * no posted voucher, no entry, no consumed number (FR-GEN-015/-016/-017).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import {
  CONTRA_VOUCHER_REPOSITORY,
  ContraVoucherRepository,
} from '../domain/ports/contra-voucher.repository';

@Injectable()
export class PostContraUseCase {
  constructor(
    @Inject(CONTRA_VOUCHER_REPOSITORY) private readonly repo: ContraVoucherRepository,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<{ entryId: string; entryNo: string }> {
    return this.uow.run(async () => {
      const voucher = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!voucher) throw new NotFoundError(`Contra voucher ${id} not found`);
      voucher.assertPostable();

      const entry = await this.posting.post(voucher.toPostingCommand(actor.userId));

      voucher.markPosted(entry.id, entry.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(voucher, voucher.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'ContraVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { entryId: entry.id, entryNo: entry.props.entryNo };
    });
  }
}
