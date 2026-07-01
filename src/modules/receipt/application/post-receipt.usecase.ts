/**
 * PostReceiptUseCase — post a receipt DRAFT atomically (design §5.1, FR-REC-009..017). Inside ONE
 * uow.run:
 *   1. row-lock the draft (findByIdForUpdate -> anti-double-post, AC8);
 *   2. assertPostable (DRAFT + composition + reference-XOR + cheque-ref);
 *   3. (IPC-linked) re-read the IPC + its CURRENT outstanding INSIDE the tx and re-cap
 *      (assertWithinOutstanding, AC4) — also re-verifies the IPC is still POSTED;
 *   4. resolve the REC accounts (MAS) (+ general-target facts for a GENERAL receipt);
 *   5. buildReceiptCommand -> the balanced, fully-tagged §4 RECEIPT command;
 *   6. posting.post(cmd) — the single writer runs period->project->tags->refs->balance->NUMBER(last)->write;
 *   7. markPosted with the allocated gapless RECEIPT number; save; audit.
 * Any failure rolls everything back — no posted receipt, no entry, NO consumed number (AC5/AC7). REC
 * writes NO ledger line itself — it only builds a command and calls PostingService (CLAUDE.md #1/#2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { buildReceiptCommand, GeneralTargetAccountFacts } from '../domain/receipt-posting';
import { IpcNotPostedError } from '../domain/errors';
import { RECEIPT_REPOSITORY, ReceiptRepository } from '../domain/ports/receipt.repository';
import { RECEIPT_ACCOUNT_MAP_PORT, ReceiptAccountMapPort } from '../domain/ports/receipt-account-map.port';
import { IPC_REFERENCE_PORT, IpcReferencePort } from '../domain/ports/ipc-reference.port';

export interface PostReceiptResult {
  entryId: string;
  entryNo: string;
}

@Injectable()
export class PostReceiptUseCase {
  constructor(
    @Inject(RECEIPT_REPOSITORY) private readonly repo: ReceiptRepository,
    @Inject(RECEIPT_ACCOUNT_MAP_PORT) private readonly accounts: ReceiptAccountMapPort,
    @Inject(IPC_REFERENCE_PORT) private readonly ipcRef: IpcReferencePort,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<PostReceiptResult> {
    return this.uow.run(async () => {
      const receipt = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!receipt) throw new NotFoundError(`Receipt ${id} not found`);
      receipt.assertPostable();

      let generalTarget: GeneralTargetAccountFacts | undefined;

      if (receipt.isIpcLinked) {
        if (!receipt.props.ipcId) {
          throw new ValidationError(`Receipt ${id} is IPC-linked but has no ipcId`, { id });
        }
        // Re-verify the IPC is still POSTED and re-check the cap against the AUTHORITATIVE outstanding
        // inside the post transaction (FR-REC-017; edge case 8 — two receipts racing one IPC).
        const ipc = await this.ipcRef.findPostedIpc(receipt.props.ipcId, actor.companyId);
        if (!ipc) throw new NotFoundError(`IPC ${receipt.props.ipcId} not found`, { ipcId: receipt.props.ipcId });
        if (ipc.status !== 'POSTED') throw new IpcNotPostedError(ipc.id, ipc.status);
        const outstanding = await this.ipcRef.outstandingForIpc(receipt.props.ipcId, actor.companyId);
        receipt.assertWithinOutstanding(outstanding);
      } else {
        if (!receipt.props.generalTargetAccountId) {
          throw new ValidationError(`Receipt ${id} is general but has no generalTargetAccountId`, { id });
        }
        const facts = await this.accounts.generalTargetFacts(actor.companyId, receipt.props.generalTargetAccountId);
        if (!facts) {
          throw new ValidationError(`Target account ${receipt.props.generalTargetAccountId} is not configured`, {
            accountId: receipt.props.generalTargetAccountId,
          });
        }
        generalTarget = facts;
      }

      const accountMap = await this.accounts.resolve(actor.companyId);
      const cmd = buildReceiptCommand(receipt, accountMap, actor.userId, generalTarget);
      const entry = await this.posting.post(cmd);

      receipt.markPosted(entry.id, entry.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(receipt, receipt.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'Receipt',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { entryId: entry.id, entryNo: entry.props.entryNo };
    });
  }
}
