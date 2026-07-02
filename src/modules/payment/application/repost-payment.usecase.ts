/**
 * RepostPaymentUseCase — append-only correction of a POSTED payment (FR-LED-027). Inside ONE uow.run:
 * row-lock the payment, assert POSTED, apply the corrected patch to a transient working copy, re-resolve +
 * re-validate every allocation (control account / dims / cap) against the CURRENT outstanding, build the
 * corrected PAYMENT command, then PostingService.repost = reverse(original) + post(corrected) in the SAME
 * transaction. The persisted payment row is re-stamped POSTED with the NEW entry + its own new gapless
 * number; the ORIGINAL ledger entry and the ORIGINAL payment number are never mutated.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { EditPayment, NewPayment, PaymentVoucher } from '../domain/payment-voucher';
import { buildPaymentCommand } from '../domain/payment-posting';
import { PAYMENT_REPOSITORY, PaymentRepository } from '../domain/ports/payment.repository';
import { PAYABLE_LOOKUP_PORT, PayableLookupPort } from '../domain/ports/payable-lookup.port';
import { PAYMENT_ACCOUNT_MAP_PORT, PaymentAccountMapPort } from '../domain/ports/payment-account-map.port';
import { resolveAndBindAllocations } from './resolve-allocations';
import { buildConcreteAccountMap } from './account-map';

export interface RepostPaymentResult {
  entryNo: string;
  reversalEntryNo: string;
}

@Injectable()
export class RepostPaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
    @Inject(PAYABLE_LOOKUP_PORT) private readonly payableLookup: PayableLookupPort,
    @Inject(PAYMENT_ACCOUNT_MAP_PORT) private readonly accountMap: PaymentAccountMapPort,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, patch: EditPayment, reason: string, actor: Actor): Promise<RepostPaymentResult> {
    return this.uow.run(async () => {
      const payment = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!payment) throw new NotFoundError(`Payment ${id} not found`);
      payment.assertPosted();
      if (!payment.props.journalEntryId) {
        throw new ValidationError(`Payment ${id} has no ledger entry to reverse`, { id });
      }

      const corrected = PaymentVoucher.createDraft(
        id,
        actor.companyId,
        actor.financialYearId,
        this.buildCorrected(patch, payment),
      );
      corrected.assertPostable();
      await resolveAndBindAllocations(corrected, this.payableLookup, actor.companyId);

      const map = await this.accountMap.resolve(actor.companyId);
      const cmd = buildPaymentCommand(corrected, buildConcreteAccountMap(map), actor.userId);

      const { reversal, reposted } = await this.posting.repost(
        payment.props.journalEntryId,
        actor.companyId,
        reason,
        actor.userId,
        cmd,
      );

      // Re-stamp the persisted row: corrected figures + the NEW entry/number, still POSTED.
      corrected.markPosted(reposted.id, reposted.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(
        PaymentVoucher.rehydrate(id, { ...corrected.props, version: payment.version }),
        payment.version,
      );
      await this.audit.record({
        action: 'POST',
        entityType: 'PaymentVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { entryNo: reposted.props.entryNo, reversalEntryNo: reversal.props.entryNo };
    });
  }

  /** Merge the patch over the current posted payment's fields into a create-shaped corrected input. */
  private buildCorrected(patch: EditPayment, payment: PaymentVoucher): NewPayment {
    const p = payment.props;
    return {
      partyId: patch.partyId !== undefined ? patch.partyId : p.partyId,
      paymentDate: patch.paymentDate ?? p.paymentDate,
      paymentMode: patch.paymentMode ?? p.paymentMode,
      paymentAccountId: patch.paymentAccountId ?? p.paymentAccountId,
      chequeTxnRef: patch.chequeTxnRef !== undefined ? patch.chequeTxnRef : p.chequeTxnRef,
      bankChargesAmount:
        patch.bankChargesAmount !== undefined ? patch.bankChargesAmount : p.bankChargesAmount.amount,
      bankChargesProjectId:
        patch.bankChargesProjectId !== undefined ? patch.bankChargesProjectId : p.bankChargesProjectId,
      bankChargesCostCentreId:
        patch.bankChargesCostCentreId !== undefined ? patch.bankChargesCostCentreId : p.bankChargesCostCentreId,
      bankChargesPurposeId:
        patch.bankChargesPurposeId !== undefined ? patch.bankChargesPurposeId : p.bankChargesPurposeId,
      paymentAmount: patch.paymentAmount ?? p.paymentAmount.amount,
      narration: patch.narration !== undefined ? patch.narration : p.narration,
      allocations:
        patch.allocations ??
        p.allocations.map((a) => ({
          payableType: a.payableType,
          payableId: a.payableId,
          amountAllocated: a.amountAllocated.amount,
        })),
    };
  }
}
