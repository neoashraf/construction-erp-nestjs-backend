/**
 * Reverse use cases — append-only correction of a POSTED contra/journal/opening voucher (design §5.3,
 * FR-GEN-018). Inside ONE uow.run: row-lock the voucher, assert POSTED, call the single writer
 * `PostingService.reverse(journalEntryId, reason)` (a NEW linked reversal entry, Dr↔Cr swapped; the
 * original ledger entry is never mutated), mark the voucher CANCELLED, save, audit. LED rejects
 * reversing an already-reversed/reversal entry and a closed-period/closed-project reversal.
 *
 * Contra and journal share the exact flow; the two thin use cases differ only in their repository.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { NotPostedError } from '../domain/errors';
import {
  CONTRA_VOUCHER_REPOSITORY,
  ContraVoucherRepository,
} from '../domain/ports/contra-voucher.repository';
import {
  JOURNAL_VOUCHER_REPOSITORY,
  JournalVoucherRepository,
} from '../domain/ports/journal-voucher.repository';

/** The minimal voucher surface reverse needs (both aggregates satisfy it). */
interface ReversibleVoucher {
  readonly version: number;
  readonly props: { status: string; journalEntryId: string | null };
  markCancelled(): void;
}
interface ReversibleRepo<V extends ReversibleVoucher> {
  findByIdForUpdate(id: string, companyId: string): Promise<V | null>;
  save(voucher: V, expectedVersion: number): Promise<void>;
}

async function reverse<V extends ReversibleVoucher>(
  repo: ReversibleRepo<V>,
  posting: PostingService,
  audit: AuditService,
  uow: UnitOfWork,
  entityType: string,
  id: string,
  reason: string,
  actor: Actor,
): Promise<{ reversalEntryId: string; reversalEntryNo: string }> {
  return uow.run(async () => {
    const voucher = await repo.findByIdForUpdate(id, actor.companyId);
    if (!voucher) throw new NotFoundError(`${entityType} ${id} not found`);
    if (voucher.props.status !== 'POSTED') throw new NotPostedError(voucher.props.status);
    if (!voucher.props.journalEntryId) {
      throw new ValidationError(`${entityType} ${id} has no ledger entry to reverse`, { id });
    }

    const reversal = await posting.reverse(voucher.props.journalEntryId, actor.companyId, reason, actor.userId);
    voucher.markCancelled();
    await repo.save(voucher, voucher.version);
    await audit.record({
      action: 'CANCEL',
      entityType,
      entityId: id,
      actorId: actor.userId,
      companyId: actor.companyId,
    });
    return { reversalEntryId: reversal.id, reversalEntryNo: reversal.props.entryNo };
  });
}

@Injectable()
export class ReverseContraUseCase {
  constructor(
    @Inject(CONTRA_VOUCHER_REPOSITORY) private readonly repo: ContraVoucherRepository,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  execute(id: string, reason: string, actor: Actor) {
    return reverse(this.repo, this.posting, this.audit, this.uow, 'ContraVoucher', id, reason, actor);
  }
}

@Injectable()
export class ReverseJournalUseCase {
  constructor(
    @Inject(JOURNAL_VOUCHER_REPOSITORY) private readonly repo: JournalVoucherRepository,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  execute(id: string, reason: string, actor: Actor) {
    return reverse(this.repo, this.posting, this.audit, this.uow, 'JournalVoucher', id, reason, actor);
  }
}
