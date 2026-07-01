/**
 * CancelIpcUseCase — append-only cancel of a POSTED IPC (FR-SAL-021, FR-SAL-022). Inside ONE uow.run:
 * row-lock the IPC, assert POSTED, call the single writer PostingService.reverse(journalEntryId, reason)
 * (a NEW linked reversal entry with its OWN gapless number, Dr↔Cr swapped; the original ledger entry and
 * its IPC number are never mutated), mark the IPC CANCELLED, save, audit. LED rejects reversing an
 * already-reversed entry and a reversal into a closed period / against a closed project.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { NotPostedError } from '../domain/errors';
import { IPC_REPOSITORY, IpcRepository } from '../domain/ports/ipc.repository';

export interface CancelIpcResult {
  reversalEntryId: string;
  reversalEntryNo: string;
}

@Injectable()
export class CancelIpcUseCase {
  constructor(
    @Inject(IPC_REPOSITORY) private readonly repo: IpcRepository,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, reason: string, actor: Actor): Promise<CancelIpcResult> {
    return this.uow.run(async () => {
      const ipc = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!ipc) throw new NotFoundError(`IPC ${id} not found`);
      if (ipc.props.status !== 'POSTED') throw new NotPostedError(ipc.props.status);
      if (!ipc.props.journalEntryId) {
        throw new ValidationError(`IPC ${id} has no ledger entry to reverse`, { id });
      }

      const reversal = await this.posting.reverse(
        ipc.props.journalEntryId,
        actor.companyId,
        reason,
        actor.userId,
      );
      ipc.markCancelled();
      await this.repo.save(ipc, ipc.version);
      await this.audit.record({
        action: 'CANCEL',
        entityType: 'SalesInvoice',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { reversalEntryId: reversal.id, reversalEntryNo: reversal.props.entryNo };
    });
  }
}
