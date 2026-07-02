/**
 * CreatePaymentUseCase — save a payment DRAFT (no number, no ledger impact). For each allocation, resolves
 * the referenced payable (PayableLookup) server-side to derive the control account / dims / party / accrued
 * and to reject a non-settleable payable or an allocation exceeding its outstanding; the resolved binding is
 * stored on the draft's allocation rows. Runs inside the caller's UoW; audits inside the transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { NewPayment, PaymentVoucher } from '../domain/payment-voucher';
import { PAYMENT_REPOSITORY, PaymentRepository } from '../domain/ports/payment.repository';
import { PAYABLE_LOOKUP_PORT, PayableLookupPort } from '../domain/ports/payable-lookup.port';
import { resolveAndBindAllocations } from './resolve-allocations';

export interface CreatePaymentResult {
  id: string;
  budgetWarnings: string[];
}

@Injectable()
export class CreatePaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
    @Inject(PAYABLE_LOOKUP_PORT) private readonly payableLookup: PayableLookupPort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: NewPayment, actor: Actor): Promise<CreatePaymentResult> {
    return this.uow.run(async () => {
      const payment = PaymentVoucher.createDraft(this.ids.next(), actor.companyId, actor.financialYearId, input);
      await resolveAndBindAllocations(payment, this.payableLookup, actor.companyId);

      await this.repo.insert(payment);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'PaymentVoucher',
        entityId: payment.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: payment.id, budgetWarnings: [] };
    });
  }
}
