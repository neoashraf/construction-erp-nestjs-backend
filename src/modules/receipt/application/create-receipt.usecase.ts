/**
 * CreateReceiptUseCase — save a receipt DRAFT (no number, no ledger impact — FR-REC-001). For an
 * IPC-linked receipt, resolves the referenced posted IPC (SAL) to derive partyId/projectId/costCentreId/
 * purposeId server-side (never client-supplied — API contract) and rejects a non-POSTED IPC
 * (FR-REC-002) and an over-application against its current outstanding (FR-REC-017). For a general
 * receipt, validates the supplied `generalTargetAccountId` classification (FR-REC-003). Runs inside the
 * caller's UoW; audits inside the transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { Receipt, NewReceipt } from '../domain/receipt';
import { IpcNotPostedError, InvalidGeneralTargetError } from '../domain/errors';
import { RECEIPT_REPOSITORY, ReceiptRepository } from '../domain/ports/receipt.repository';
import { RECEIPT_ACCOUNT_MAP_PORT, ReceiptAccountMapPort } from '../domain/ports/receipt-account-map.port';
import { IPC_REFERENCE_PORT, IpcReferencePort } from '../domain/ports/ipc-reference.port';

/** The create input; for IPC_LINKED, partyId/projectId/costCentreId/purposeId are resolved from the IPC. */
export type CreateReceiptInput = Omit<
  NewReceipt,
  'partyId' | 'projectId' | 'costCentreId' | 'purposeId' | 'ipcId' | 'generalTargetAccountId'
> & {
  partyId?: string;
  projectId?: string | null;
  costCentreId?: string;
  purposeId?: string | null;
  ipcId?: string | null;
  generalTargetAccountId?: string | null;
};

@Injectable()
export class CreateReceiptUseCase {
  constructor(
    @Inject(RECEIPT_REPOSITORY) private readonly repo: ReceiptRepository,
    @Inject(RECEIPT_ACCOUNT_MAP_PORT) private readonly accounts: ReceiptAccountMapPort,
    @Inject(IPC_REFERENCE_PORT) private readonly ipcRef: IpcReferencePort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateReceiptInput, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      let resolved: NewReceipt;

      if (input.receiptType === 'IPC_LINKED') {
        if (!input.ipcId) throw new ValidationError('ipcId is required for an IPC-linked receipt');
        const ipc = await this.ipcRef.findPostedIpc(input.ipcId, actor.companyId);
        if (!ipc) throw new NotFoundError(`IPC ${input.ipcId} not found for this company`, { ipcId: input.ipcId });
        if (ipc.status !== 'POSTED') throw new IpcNotPostedError(ipc.id, ipc.status);

        resolved = {
          ...input,
          partyId: ipc.customerId,
          projectId: ipc.projectId,
          costCentreId: ipc.costCentreId,
          purposeId: ipc.purposeId,
          ipcId: input.ipcId,
          generalTargetAccountId: null,
        };
      } else {
        if (!input.generalTargetAccountId) {
          throw new ValidationError('generalTargetAccountId is required for a general receipt');
        }
        const facts = await this.accounts.generalTargetFacts(actor.companyId, input.generalTargetAccountId);
        if (!facts) throw new InvalidGeneralTargetError(input.generalTargetAccountId);
        if (!input.partyId) throw new ValidationError('partyId is required');
        if (!input.costCentreId) throw new ValidationError('costCentreId is required');
        resolved = {
          ...input,
          partyId: input.partyId,
          projectId: input.projectId ?? null,
          costCentreId: input.costCentreId,
          purposeId: input.purposeId ?? null,
          ipcId: null,
          generalTargetAccountId: input.generalTargetAccountId,
        };
      }

      const receipt = Receipt.createDraft(this.ids.next(), actor.companyId, actor.financialYearId, resolved);

      // Pre-check the over-application cap at draft build time (re-checked authoritatively at post).
      if (receipt.isIpcLinked && receipt.props.ipcId) {
        const outstanding = await this.ipcRef.outstandingForIpc(receipt.props.ipcId, actor.companyId);
        receipt.assertWithinOutstanding(outstanding);
      }

      await this.repo.insert(receipt);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'Receipt',
        entityId: receipt.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: receipt.id };
    });
  }
}
