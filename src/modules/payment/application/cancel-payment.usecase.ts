/**
 * CancelPaymentUseCase — append-only cancel of a POSTED payment. Inside ONE uow.run: row-lock the payment,
 * assert POSTED, call PostingService.reverse(journalEntryId, reason) (a NEW linked reversal entry with its
 * OWN gapless number, Dr<->Cr swapped; the original entry and its payment number are never mutated), mark
 * the payment CANCELLED, save, audit. Once the reversal exists, the cancelled payment's allocation drops
 * out of PAY's applied-total projection, so each settled payable's outstanding restores on the next read —
 * nothing to unwind. LED rejects reversing an already-reversed entry / into a closed period.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { PAYMENT_REPOSITORY, PaymentRepository } from '../domain/ports/payment.repository';

export interface CancelPaymentResult {
  reversalEntryId: string;
  reversalEntryNo: string;
}

@Injectable()
export class CancelPaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, reason: string, actor: Actor): Promise<CancelPaymentResult> {
    return this.uow.run(async () => {
      const payment = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!payment) throw new NotFoundError(`Payment ${id} not found`);
      payment.assertCancellable();
      if (!payment.props.journalEntryId) {
        throw new ValidationError(`Payment ${id} has no ledger entry to reverse`, { id });
      }

      const reversal = await this.posting.reverse(payment.props.journalEntryId, actor.companyId, reason, actor.userId);
      payment.markCancelled();
      await this.repo.save(payment, payment.version);
      await this.audit.record({
        action: 'CANCEL',
        entityType: 'PaymentVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { reversalEntryId: reversal.id, reversalEntryNo: reversal.props.entryNo };
    });
  }
}
