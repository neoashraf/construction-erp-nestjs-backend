/**
 * CancelReceiptUseCase — append-only cancel of a POSTED receipt (FR-REC-021, FR-REC-022). Inside ONE
 * uow.run: row-lock the receipt, assert POSTED, call the single writer
 * PostingService.reverse(journalEntryId, reason) (a NEW linked reversal entry with its OWN gapless
 * number, Dr<->Cr swapped; the original ledger entry and its receipt number are never mutated), mark the
 * receipt CANCELLED, save, audit. Once the reversal exists, the cancelled receipt drops out of the
 * receipt_allocation view (design §2.5/§5.3) so the referenced IPC's outstanding restores on the next
 * read — nothing to unwind (FR-REC-022). LED rejects reversing an already-reversed entry and a reversal
 * into a closed period / against a closed project.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { RECEIPT_REPOSITORY, ReceiptRepository } from '../domain/ports/receipt.repository';

export interface CancelReceiptResult {
  reversalEntryId: string;
  reversalEntryNo: string;
}

@Injectable()
export class CancelReceiptUseCase {
  constructor(
    @Inject(RECEIPT_REPOSITORY) private readonly repo: ReceiptRepository,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, reason: string, actor: Actor): Promise<CancelReceiptResult> {
    return this.uow.run(async () => {
      const receipt = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!receipt) throw new NotFoundError(`Receipt ${id} not found`);
      receipt.assertCancellable();
      if (!receipt.props.journalEntryId) {
        throw new ValidationError(`Receipt ${id} has no ledger entry to reverse`, { id });
      }

      const reversal = await this.posting.reverse(
        receipt.props.journalEntryId,
        actor.companyId,
        reason,
        actor.userId,
      );
      receipt.markCancelled();
      await this.repo.save(receipt, receipt.version);
      await this.audit.record({
        action: 'CANCEL',
        entityType: 'Receipt',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { reversalEntryId: reversal.id, reversalEntryNo: reversal.props.entryNo };
    });
  }
}
