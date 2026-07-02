/**
 * CancelGrnUseCase — cancel a POSTED GRN under the RESOLVED §10 Q4 option (a) (see grn.ts): a POSTED GRN
 * moved no stock and wrote no ledger entry, so the cancel is a **status flip only** (POSTED -> CANCELLED),
 * audit-logged — NO `inventory.reverseReceipt`, NO `posting.reverse` (there is nothing to unwind; the
 * bill's own cancel path unwinds the bill's inventory/ledger, FR-PUR-022). The GRN row itself is retained
 * (not deleted) so the physical-receipt trail stays auditable; the match/read side excludes CANCELLED
 * GRNs from every Σ received (FR-PUR-017/-018).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { GRN_REPOSITORY, GrnRepository } from '../domain/ports/grn.repository';

@Injectable()
export class CancelGrnUseCase {
  // NOTE (option (a), §10 Q4): no InventoryService, no PostingService — nothing to reverse. See class doc.
  constructor(
    @Inject(GRN_REPOSITORY) private readonly grns: GrnRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, reason: string, actor: Actor): Promise<{ id: string; status: 'CANCELLED' }> {
    return this.uow.run(async () => {
      const grn = await this.grns.findByIdForUpdate(id, actor.companyId);
      if (!grn) throw new NotFoundError(`GRN ${id} not found`);
      grn.markCancelled(); // POSTED-only guard (409 VOUCHER_NOT_POSTED otherwise)
      await this.grns.save(grn, grn.version);
      await this.audit.record({
        action: 'CANCEL',
        entityType: 'Grn',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
        after: { status: 'CANCELLED', reason },
      });
      return { id, status: 'CANCELLED' as const };
    });
  }
}
