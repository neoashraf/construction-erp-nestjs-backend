/**
 * PostPaymentUseCase — post a payment DRAFT atomically. Inside ONE uow.run:
 *   1. row-lock the draft (findByIdForUpdate -> anti-double-post);
 *   2. assertPostable (DRAFT + >=1 allocation + composition);
 *   3. re-resolve every allocation INSIDE the tx (re-check cap against the CURRENT outstanding, re-bind
 *      control account / dims / party / accrued);
 *   4. build the concrete PaymentAccountMap (labourCost + bankCharges from PaymentAccountMapPort;
 *      controlAccountFor reads the bound allocation);
 *   5. buildPaymentCommand -> the balanced, fully-tagged PAYMENT command;
 *   6. posting.post(cmd) — the single writer runs period->tags->balance->NUMBER->write;
 *   7. markPosted with the allocated gapless PAYMENT number; save (replaces allocation rows); audit.
 * Any failure rolls everything back — no posted payment, no entry, NO consumed number. PAY writes NO ledger
 * line itself — it only builds a command and calls PostingService (CLAUDE.md #1/#2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { buildPaymentCommand } from '../domain/payment-posting';
import { PAYMENT_REPOSITORY, PaymentRepository } from '../domain/ports/payment.repository';
import { PAYABLE_LOOKUP_PORT, PayableLookupPort } from '../domain/ports/payable-lookup.port';
import { PAYMENT_ACCOUNT_MAP_PORT, PaymentAccountMapPort } from '../domain/ports/payment-account-map.port';
import { resolveAndBindAllocations } from './resolve-allocations';
import { buildConcreteAccountMap } from './account-map';

export interface PostPaymentResult {
  entryId: string;
  entryNo: string;
}

@Injectable()
export class PostPaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
    @Inject(PAYABLE_LOOKUP_PORT) private readonly payableLookup: PayableLookupPort,
    @Inject(PAYMENT_ACCOUNT_MAP_PORT) private readonly accountMap: PaymentAccountMapPort,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<PostPaymentResult> {
    return this.uow.run(async () => {
      const payment = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!payment) throw new NotFoundError(`Payment ${id} not found`);
      payment.assertPostable();

      // Re-resolve + re-cap + re-bind INSIDE the tx (authoritative).
      await resolveAndBindAllocations(payment, this.payableLookup, actor.companyId);

      const map = await this.accountMap.resolve(actor.companyId);
      const accounts = buildConcreteAccountMap(map);
      const cmd = buildPaymentCommand(payment, accounts, actor.userId);
      const entry = await this.posting.post(cmd);

      payment.markPosted(entry.id, entry.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(payment, payment.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'PaymentVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { entryId: entry.id, entryNo: entry.props.entryNo };
    });
  }
}
