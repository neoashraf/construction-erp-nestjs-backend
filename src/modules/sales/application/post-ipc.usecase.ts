/**
 * PostIpcUseCase — post an IPC DRAFT atomically (design §5.1, FR-SAL-009..013). Inside ONE uow.run:
 *   1. row-lock the draft (findByIdForUpdate → anti-double-post, AC8);
 *   2. assert DRAFT (assertPostable);
 *   3. re-read the remaining advance INSIDE the tx and re-cap (assertAdvanceWithinRemaining, AC4);
 *   4. resolve the six sales accounts (MAS);
 *   5. buildIpcCommand → the balanced, fully-tagged §4 SALES_IPC command;
 *   6. posting.post(cmd) — the single writer runs period→project→tags→refs→balance→NUMBER(last)→write;
 *   7. markPosted with the allocated gapless Mushak number; save; audit.
 * Any failure rolls everything back — no posted IPC, no entry, NO consumed number (AC5/AC7). SAL writes
 * NO ledger line itself — it only builds a command and calls PostingService (CLAUDE.md #1/#2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { buildIpcCommand } from '../domain/ipc-posting';
import { IPC_REPOSITORY, IpcRepository } from '../domain/ports/ipc.repository';
import {
  ADVANCE_BALANCE_PORT,
  AdvanceBalancePort,
} from '../domain/ports/advance-balance.port';
import {
  SALES_ACCOUNT_MAP_PORT,
  SalesAccountMapPort,
} from '../domain/ports/sales-account-map.port';

export interface PostIpcResult {
  entryId: string;
  entryNo: string;
}

@Injectable()
export class PostIpcUseCase {
  constructor(
    @Inject(IPC_REPOSITORY) private readonly repo: IpcRepository,
    @Inject(SALES_ACCOUNT_MAP_PORT) private readonly accounts: SalesAccountMapPort,
    @Inject(ADVANCE_BALANCE_PORT) private readonly advance: AdvanceBalancePort,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<PostIpcResult> {
    return this.uow.run(async () => {
      const ipc = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!ipc) throw new NotFoundError(`IPC ${id} not found`);
      ipc.assertPostable();

      // Re-check the advance cap against the authoritative remaining advance inside the tx (FR-SAL-008).
      const remaining = await this.advance.remainingAdvance(
        actor.companyId,
        ipc.props.projectId,
        ipc.props.customerId,
      );
      ipc.assertAdvanceWithinRemaining(remaining);

      const accountMap = await this.accounts.resolve(actor.companyId);
      const cmd = buildIpcCommand(ipc, accountMap, actor.userId);
      const entry = await this.posting.post(cmd);

      ipc.markPosted(entry.id, entry.props.entryNo, actor.userId, this.clock.now());
      await this.repo.save(ipc, ipc.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'SalesInvoice',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { entryId: entry.id, entryNo: entry.props.entryNo };
    });
  }
}
