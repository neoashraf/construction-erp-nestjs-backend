/**
 * ApprovePurchaseOrderUseCase — DRAFT -> APPROVED (FR-PUR-002). Writes NO ledger line, draws NO PURCHASE
 * number — a PO is a non-posting commitment (FR-PUR-001). Inside one uow.run: row-lock the PO, approve(),
 * save, audit.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PURCHASE_ORDER_REPOSITORY, PurchaseOrderRepository } from '../domain/ports/purchase-order.repository';

export interface ApprovePurchaseOrderResult {
  status: string;
  approvedBy: string;
  approvedAt: Date;
}

@Injectable()
export class ApprovePurchaseOrderUseCase {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly repo: PurchaseOrderRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<ApprovePurchaseOrderResult> {
    return this.uow.run(async () => {
      const po = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!po) throw new NotFoundError(`Purchase Order ${id} not found`);
      const now = this.clock.now();
      po.approve(actor.userId, now);
      await this.repo.save(po, po.version);
      await this.audit.record({
        action: 'APPROVE',
        entityType: 'PurchaseOrder',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { status: po.props.status, approvedBy: actor.userId, approvedAt: now };
    });
  }
}
