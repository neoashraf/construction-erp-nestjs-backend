/**
 * RepostIpcUseCase — append-only correction of a POSTED IPC (FR-SAL-021, FR-SAL-022; FR-LED-027). Inside
 * ONE uow.run: row-lock the IPC, assert POSTED, then PostingService.repost = reverse(original) +
 * post(corrected) — both in the SAME transaction, so if the corrected post fails after the reversal, both
 * roll back and the original stays intact and unreversed (edge case 11). The corrected IPC figures are
 * recomputed from the supplied fields via a transient Ipc aggregate (same money math as create); the
 * persisted IPC row is re-stamped POSTED with the NEW entry + its own new gapless number. The ORIGINAL
 * ledger entry and the ORIGINAL IPC number are never mutated; the reversal + corrected posts each get
 * their own next number.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { Ipc, EditIpc, NewIpc } from '../domain/ipc';
import { buildIpcCommand } from '../domain/ipc-posting';
import { NotPostedError } from '../domain/errors';
import { IPC_REPOSITORY, IpcRepository } from '../domain/ports/ipc.repository';
import { IPC_CONFIG_PORT, IpcConfigPort } from '../domain/ports/ipc-config.port';
import {
  ADVANCE_BALANCE_PORT,
  AdvanceBalancePort,
} from '../domain/ports/advance-balance.port';
import {
  SALES_ACCOUNT_MAP_PORT,
  SalesAccountMapPort,
} from '../domain/ports/sales-account-map.port';

export interface RepostIpcResult {
  entryId: string;
  entryNo: string;
  reversalEntryId: string;
  reversalEntryNo: string;
  currentlyDueAmount: string;
}

@Injectable()
export class RepostIpcUseCase {
  constructor(
    @Inject(IPC_REPOSITORY) private readonly repo: IpcRepository,
    @Inject(SALES_ACCOUNT_MAP_PORT) private readonly accounts: SalesAccountMapPort,
    @Inject(IPC_CONFIG_PORT) private readonly config: IpcConfigPort,
    @Inject(ADVANCE_BALANCE_PORT) private readonly advance: AdvanceBalancePort,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, patch: EditIpc, reason: string, actor: Actor): Promise<RepostIpcResult> {
    return this.uow.run(async () => {
      const ipc = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!ipc) throw new NotFoundError(`IPC ${id} not found`);
      if (ipc.props.status !== 'POSTED') throw new NotPostedError(ipc.props.status);
      if (!ipc.props.journalEntryId) {
        throw new ValidationError(`IPC ${id} has no ledger entry to reverse`, { id });
      }

      // Build the CORRECTED transient aggregate (same id/source; recompute figures on the merged fields).
      const rates = await this.config.rates(actor.companyId);
      const corrected = this.buildCorrected(id, patch, ipc);
      const remaining = await this.advance.remainingAdvance(
        actor.companyId,
        corrected.projectId,
        ipc.props.customerId,
      );
      const correctedIpc = Ipc.createDraft(
        id,
        actor.companyId,
        actor.financialYearId,
        { ...corrected, customerId: ipc.props.customerId },
        rates,
        remaining,
      );
      const cmd = buildIpcCommand(correctedIpc, await this.accounts.resolve(actor.companyId), actor.userId);

      const { reversal, reposted } = await this.posting.repost(
        ipc.props.journalEntryId,
        actor.companyId,
        reason,
        actor.userId,
        cmd,
      );

      // Re-stamp the persisted IPC row: corrected figures + the NEW entry/number, still POSTED.
      correctedIpc.markPosted(reposted.id, reposted.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(this.mergePersisted(ipc, correctedIpc), ipc.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'SalesInvoice',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return {
        entryId: reposted.id,
        entryNo: reposted.props.entryNo,
        reversalEntryId: reversal.id,
        reversalEntryNo: reversal.props.entryNo,
        currentlyDueAmount: correctedIpc.props.currentlyDueAmount.amount.toFixed(4),
      };
    });
  }

  /** Merge the patch over the current posted IPC's fields to the create-shaped corrected input. */
  private buildCorrected(id: string, patch: EditIpc, ipc: Ipc): Omit<NewIpc, 'customerId'> {
    const p = ipc.props;
    return {
      projectId: patch.projectId ?? p.projectId,
      ipcSeqNo: patch.ipcSeqNo ?? p.ipcSeqNo,
      ipcDate: patch.ipcDate ?? p.ipcDate,
      billDate: patch.billDate ?? p.billDate,
      dueDate: patch.dueDate ?? p.dueDate,
      workCompletedPct: patch.workCompletedPct ?? p.workCompletedPct,
      certifiedAmount: patch.certifiedAmount ?? p.certifiedAmount.amount,
      costCentreId: patch.costCentreId ?? p.costCentreId,
      purposeId: patch.purposeId ?? p.purposeId,
      outputVatAmount: patch.outputVatAmount !== undefined ? patch.outputVatAmount : undefined,
      aitTdsAmount: patch.aitTdsAmount !== undefined ? patch.aitTdsAmount : p.aitTdsAmount.amount,
      retentionAmount: patch.retentionAmount !== undefined ? patch.retentionAmount : undefined,
      advanceRecoveredAmount:
        patch.advanceRecoveredAmount !== undefined ? patch.advanceRecoveredAmount : undefined,
      narration: patch.narration !== undefined ? patch.narration : p.narration,
    };
    void id;
  }

  /**
   * Preserve the persisted row's `version` (for the optimistic-lock save) while carrying the corrected,
   * newly-posted props. The corrected transient aggregate already holds every corrected figure + the new
   * entry; we rehydrate it with the original row's version so the UPDATE hits the right revision.
   */
  private mergePersisted(original: Ipc, corrected: Ipc): Ipc {
    return Ipc.rehydrate(original.id, { ...corrected.props, version: original.version });
  }
}
