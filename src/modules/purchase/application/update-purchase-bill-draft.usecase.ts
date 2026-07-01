/**
 * UpdatePurchaseBillDraftUseCase / DeletePurchaseBillUseCase — edit/delete a bill while DRAFT only
 * (FR-PUR-024). Update re-runs tag-consistency + recomputes figures on the new lines; delete is a hard
 * delete of a DRAFT (no ledger impact — a DRAFT never touched the ledger). Mirrors SAL's
 * UpdateIpcDraftUseCase/DeleteIpcUseCase exactly.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import {
  TAG_CONSISTENCY_SERVICE,
  TagConsistencyService,
} from '../../../core/cost-control/domain/ports/tag-consistency.port';
import { EditPurchaseBill } from '../domain/purchase-bill';
import { NotDraftError } from '../domain/errors';
import { PURCHASE_BILL_REPOSITORY, PurchaseBillRepository } from '../domain/ports/purchase-bill.repository';
import { PURCHASE_CONFIG_PORT, PurchaseConfigPort } from '../domain/ports/purchase-config.port';

@Injectable()
export class UpdatePurchaseBillDraftUseCase {
  constructor(
    @Inject(PURCHASE_BILL_REPOSITORY) private readonly repo: PurchaseBillRepository,
    @Inject(PURCHASE_CONFIG_PORT) private readonly config: PurchaseConfigPort,
    @Inject(TAG_CONSISTENCY_SERVICE) private readonly tagConsistency: TagConsistencyService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(id: string, patch: EditPurchaseBill, expectedVersion: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const bill = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!bill) throw new NotFoundError(`Purchase Bill ${id} not found`);

      const tax = await this.config.taxRates(actor.companyId);
      const lineIds = patch.lines?.map(() => this.ids.next()) ?? [];
      bill.updateDraft(patch, tax, lineIds);

      if (patch.lines !== undefined) {
        await this.tagConsistency.assertConsistent(
          { companyId: actor.companyId },
          bill.lines.map((l) => ({ projectId: l.projectId, purposeId: l.purposeId, godownId: l.godownId })),
        );
      }

      await this.repo.save(bill, expectedVersion);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'PurchaseBill',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}

@Injectable()
export class DeletePurchaseBillUseCase {
  constructor(
    @Inject(PURCHASE_BILL_REPOSITORY) private readonly repo: PurchaseBillRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const bill = await this.repo.findById(id, actor.companyId);
      if (!bill) throw new NotFoundError(`Purchase Bill ${id} not found`);
      if (bill.props.status !== 'DRAFT') throw new NotDraftError(bill.props.status);
      await this.repo.softDelete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE',
        entityType: 'PurchaseBill',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
