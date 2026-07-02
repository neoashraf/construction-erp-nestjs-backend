/**
 * UpdatePaymentDraftUseCase / DeletePaymentUseCase — edit or hard-delete a payment DRAFT ONLY; a
 * posted/cancelled payment is immutable (NotDraftError -> VOUCHER_POSTED_IMMUTABLE). A PATCH re-resolves +
 * re-validates every allocation (control account / dims / cap) server-side. Optimistic-locked by `version`.
 * Runs inside the caller's UoW; audits inside the transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { assertVersion } from '../../master-data/application/optimistic-lock';
import { EditPayment } from '../domain/payment-voucher';
import { NotDraftError } from '../domain/errors';
import { PAYMENT_REPOSITORY, PaymentRepository } from '../domain/ports/payment.repository';
import { PAYABLE_LOOKUP_PORT, PayableLookupPort } from '../domain/ports/payable-lookup.port';
import { resolveAndBindAllocations } from './resolve-allocations';

@Injectable()
export class UpdatePaymentDraftUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
    @Inject(PAYABLE_LOOKUP_PORT) private readonly payableLookup: PayableLookupPort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, patch: EditPayment, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const payment = await this.repo.findById(id, actor.companyId);
      if (!payment) throw new NotFoundError(`Payment ${id} not found`);
      assertVersion(payment.version, version, 'PaymentVoucher', id);

      payment.updateDraft(patch);
      await resolveAndBindAllocations(payment, this.payableLookup, actor.companyId);

      await this.repo.save(payment, version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'PaymentVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}

@Injectable()
export class DeletePaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const payment = await this.repo.findById(id, actor.companyId);
      if (!payment) throw new NotFoundError(`Payment ${id} not found`);
      if (payment.props.status !== 'DRAFT') throw new NotDraftError(payment.props.status);
      await this.repo.delete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE',
        entityType: 'PaymentVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
