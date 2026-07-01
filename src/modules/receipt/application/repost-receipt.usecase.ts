/**
 * RepostReceiptUseCase — append-only correction of a POSTED receipt (FR-REC-021, FR-REC-022; FR-LED-027).
 * Inside ONE uow.run: row-lock the receipt, assert POSTED, then PostingService.repost =
 * reverse(original) + post(corrected) — both in the SAME transaction, so if the corrected post fails
 * after the reversal, both roll back and the original stays intact and unreversed. The corrected receipt
 * figures are recomputed from the supplied fields via a transient Receipt aggregate (same money math as
 * create), re-resolving IPC dimensions and re-checking the outstanding cap against the authoritative
 * current outstanding. The persisted receipt row is re-stamped POSTED with the NEW entry + its own new
 * gapless number. The ORIGINAL ledger entry and the ORIGINAL receipt number are never mutated.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { Receipt, EditReceipt, NewReceipt } from '../domain/receipt';
import { buildReceiptCommand, GeneralTargetAccountFacts } from '../domain/receipt-posting';
import { IpcNotPostedError } from '../domain/errors';
import { RECEIPT_REPOSITORY, ReceiptRepository } from '../domain/ports/receipt.repository';
import { RECEIPT_ACCOUNT_MAP_PORT, ReceiptAccountMapPort } from '../domain/ports/receipt-account-map.port';
import { IPC_REFERENCE_PORT, IpcReferencePort } from '../domain/ports/ipc-reference.port';

export interface RepostReceiptResult {
  entryId: string;
  entryNo: string;
  reversalEntryId: string;
  reversalEntryNo: string;
}

@Injectable()
export class RepostReceiptUseCase {
  constructor(
    @Inject(RECEIPT_REPOSITORY) private readonly repo: ReceiptRepository,
    @Inject(RECEIPT_ACCOUNT_MAP_PORT) private readonly accounts: ReceiptAccountMapPort,
    @Inject(IPC_REFERENCE_PORT) private readonly ipcRef: IpcReferencePort,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, patch: EditReceipt, reason: string, actor: Actor): Promise<RepostReceiptResult> {
    return this.uow.run(async () => {
      const receipt = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!receipt) throw new NotFoundError(`Receipt ${id} not found`);
      receipt.assertCancellable();
      if (!receipt.props.journalEntryId) {
        throw new ValidationError(`Receipt ${id} has no ledger entry to reverse`, { id });
      }

      const merged = this.buildCorrected(patch, receipt);
      let generalTarget: GeneralTargetAccountFacts | undefined;

      if (merged.receiptType === 'IPC_LINKED') {
        if (!merged.ipcId) throw new ValidationError('ipcId is required for an IPC-linked receipt');
        const ipc = await this.ipcRef.findPostedIpc(merged.ipcId, actor.companyId);
        if (!ipc) throw new NotFoundError(`IPC ${merged.ipcId} not found`, { ipcId: merged.ipcId });
        if (ipc.status !== 'POSTED') throw new IpcNotPostedError(ipc.id, ipc.status);
        merged.partyId = ipc.customerId;
        merged.projectId = ipc.projectId;
        merged.costCentreId = ipc.costCentreId;
        merged.purposeId = ipc.purposeId;
      } else if (merged.generalTargetAccountId) {
        const facts = await this.accounts.generalTargetFacts(actor.companyId, merged.generalTargetAccountId);
        if (!facts) throw new ValidationError(`Target account ${merged.generalTargetAccountId} is not configured`);
        generalTarget = facts;
      }

      const correctedReceipt = Receipt.createDraft(id, actor.companyId, actor.financialYearId, merged);
      correctedReceipt.assertPostable();

      if (correctedReceipt.isIpcLinked && correctedReceipt.props.ipcId) {
        const outstanding = await this.ipcRef.outstandingForIpc(correctedReceipt.props.ipcId, actor.companyId);
        correctedReceipt.assertWithinOutstanding(outstanding);
      }

      const accountMap = await this.accounts.resolve(actor.companyId);
      const cmd = buildReceiptCommand(correctedReceipt, accountMap, actor.userId, generalTarget);

      const { reversal, reposted } = await this.posting.repost(
        receipt.props.journalEntryId,
        actor.companyId,
        reason,
        actor.userId,
        cmd,
      );

      // Re-stamp the persisted receipt row: corrected figures + the NEW entry/number, still POSTED.
      correctedReceipt.markPosted(reposted.id, reposted.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(this.mergePersisted(receipt, correctedReceipt), receipt.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'Receipt',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return {
        entryId: reposted.id,
        entryNo: reposted.props.entryNo,
        reversalEntryId: reversal.id,
        reversalEntryNo: reversal.props.entryNo,
      };
    });
  }

  /** Merge the patch over the current posted receipt's fields to the create-shaped corrected input. */
  private buildCorrected(patch: EditReceipt, receipt: Receipt): NewReceipt {
    const p = receipt.props;
    return {
      receiptType: patch.receiptType ?? p.receiptType,
      receiptDate: patch.receiptDate ?? p.receiptDate,
      paymentMode: patch.paymentMode ?? p.paymentMode,
      depositAccountId: patch.depositAccountId ?? p.depositAccountId,
      partyId: patch.partyId ?? p.partyId,
      projectId: patch.projectId !== undefined ? patch.projectId : p.projectId,
      costCentreId: patch.costCentreId ?? p.costCentreId,
      purposeId: patch.purposeId !== undefined ? patch.purposeId : p.purposeId,
      ipcId: patch.ipcId !== undefined ? patch.ipcId : p.ipcId,
      generalTargetAccountId:
        patch.generalTargetAccountId !== undefined ? patch.generalTargetAccountId : p.generalTargetAccountId,
      amountSettled: patch.amountSettled ?? p.amountSettled.amount,
      taxDeductedAtSource:
        patch.taxDeductedAtSource !== undefined ? patch.taxDeductedAtSource : p.taxDeductedAtSource.amount,
      chequeTxnRef: patch.chequeTxnRef !== undefined ? patch.chequeTxnRef : p.chequeTxnRef,
      narration: patch.narration !== undefined ? patch.narration : p.narration,
    };
  }

  /**
   * Preserve the persisted row's `version` (for the optimistic-lock save) while carrying the corrected,
   * newly-posted props.
   */
  private mergePersisted(original: Receipt, corrected: Receipt): Receipt {
    return Receipt.rehydrate(original.id, { ...corrected.props, version: original.version });
  }
}
