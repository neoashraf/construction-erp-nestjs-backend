/**
 * UpdateReceiptDraftUseCase / DeleteReceiptUseCase — edit or hard-delete a receipt DRAFT ONLY
 * (FR-REC-024); a posted/cancelled receipt is immutable (NotDraftError -> VOUCHER_POSTED_IMMUTABLE). A
 * PATCH re-resolves IPC dimensions (IPC-linked) and re-checks the outstanding cap on the new figures
 * server-side. Optimistic-locked by `version`. Runs inside the caller's UoW; audits inside the
 * transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { assertVersion } from '../../master-data/application/optimistic-lock';
import { EditReceipt } from '../domain/receipt';
import { NotDraftError, IpcNotPostedError } from '../domain/errors';
import { RECEIPT_REPOSITORY, ReceiptRepository } from '../domain/ports/receipt.repository';
import { IPC_REFERENCE_PORT, IpcReferencePort } from '../domain/ports/ipc-reference.port';

@Injectable()
export class UpdateReceiptDraftUseCase {
  constructor(
    @Inject(RECEIPT_REPOSITORY) private readonly repo: ReceiptRepository,
    @Inject(IPC_REFERENCE_PORT) private readonly ipcRef: IpcReferencePort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, patch: EditReceipt, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const receipt = await this.repo.findById(id, actor.companyId);
      if (!receipt) throw new NotFoundError(`Receipt ${id} not found`);
      assertVersion(receipt.version, version, 'Receipt', id);

      const effectiveIpcId = patch.ipcId !== undefined ? patch.ipcId : receipt.props.ipcId;
      let dims: Partial<EditReceipt> = {};
      if ((patch.receiptType ?? receipt.props.receiptType) === 'IPC_LINKED' && effectiveIpcId) {
        const ipc = await this.ipcRef.findPostedIpc(effectiveIpcId, actor.companyId);
        if (!ipc) throw new NotFoundError(`IPC ${effectiveIpcId} not found for this company`, { ipcId: effectiveIpcId });
        if (ipc.status !== 'POSTED') throw new IpcNotPostedError(ipc.id, ipc.status);
        dims = {
          partyId: ipc.customerId,
          projectId: ipc.projectId,
          costCentreId: ipc.costCentreId,
          purposeId: ipc.purposeId,
        };
      }

      receipt.updateDraft({ ...patch, ...dims });

      if (receipt.isIpcLinked && receipt.props.ipcId) {
        const outstanding = await this.ipcRef.outstandingForIpc(receipt.props.ipcId, actor.companyId);
        receipt.assertWithinOutstanding(outstanding);
      }

      await this.repo.save(receipt, version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'Receipt',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}

@Injectable()
export class DeleteReceiptUseCase {
  constructor(
    @Inject(RECEIPT_REPOSITORY) private readonly repo: ReceiptRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const receipt = await this.repo.findById(id, actor.companyId);
      if (!receipt) throw new NotFoundError(`Receipt ${id} not found`);
      if (receipt.props.status !== 'DRAFT') throw new NotDraftError(receipt.props.status);
      await this.repo.softDelete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE',
        entityType: 'Receipt',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
