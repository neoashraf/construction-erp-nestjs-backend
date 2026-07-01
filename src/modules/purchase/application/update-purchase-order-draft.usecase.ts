/**
 * UpdatePurchaseOrderDraftUseCase / CancelPurchaseOrderUseCase — edit a PO while DRAFT only (FR-PUR-024)
 * and cancel a DRAFT/APPROVED PO before any bill is raised against it (`409 PO_HAS_BILLS` otherwise, per
 * the API contract). Neither touches the ledger or stock (a PO is a non-posting commitment).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PoPatch } from '../domain/purchase-order';
import { PURCHASE_ORDER_REPOSITORY, PurchaseOrderRepository } from '../domain/ports/purchase-order.repository';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';

@Injectable()
export class UpdatePurchaseOrderDraftUseCase {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly repo: PurchaseOrderRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(id: string, patch: PoPatch, expectedVersion: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const po = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!po) throw new NotFoundError(`Purchase Order ${id} not found`);
      const lineIds = patch.lines?.map(() => this.ids.next()) ?? [];
      po.editDraft(patch, lineIds);
      await this.repo.save(po, expectedVersion);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'PurchaseOrder',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}

@Injectable()
export class CancelPurchaseOrderUseCase {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly repo: PurchaseOrderRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, _reason: string, expectedVersion: number, actor: Actor): Promise<void> {
    void _reason;
    await this.uow.run(async () => {
      const po = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!po) throw new NotFoundError(`Purchase Order ${id} not found`);
      // A bill raised against this PO would have advanced its status past DRAFT/APPROVED into
      // PARTIALLY_BILLED/CLOSED — cancel() itself already rejects those via InvalidPoTransitionError, so
      // "PO_HAS_BILLS" and "already progressed" collapse to the same guard here (no separate bill lookup
      // needed: the PO's own status is the single source of truth for "has a bill been raised").
      if (po.props.status === 'PARTIALLY_BILLED' || po.props.status === 'PARTIALLY_RECEIVED' || po.props.status === 'CLOSED') {
        throw new ConflictError(`Purchase Order ${id} has bills raised against it; cannot cancel`, { id });
      }
      po.cancel();
      await this.repo.save(po, expectedVersion);
      await this.audit.record({
        action: 'CANCEL',
        entityType: 'PurchaseOrder',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
