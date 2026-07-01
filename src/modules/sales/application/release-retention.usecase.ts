/**
 * ReleaseRetentionUseCase — post a controlled retention release for a POSTED IPC (design §5.2, FR-SAL-
 * 018..020). Inside ONE uow.run:
 *   1. load the IPC (must be POSTED — VOUCHER_NOT_POSTED otherwise);
 *   2. read retention held INSIDE the tx (retentionAmount − Σ POSTED releases) — the authoritative figure,
 *      re-read here exactly like PostIpcUseCase re-checks the advance cap (FR-SAL-008 pattern);
 *   3. RetentionRelease.createDraft + assertReleasable(held) — 0 < amount <= held (AC2);
 *   4. resolve AR + Retention Receivable accounts (MAS via SalesAccountMapPort);
 *   5. toPostingCommand → the §4.2 balanced JOURNAL command;
 *   6. posting.post(cmd) — the single writer runs period→project→tags→refs→balance→NUMBER(last)→write,
 *      the SAME period/project guards as an IPC post (AC3, FR-SAL-020);
 *   7. markPosted with the allocated gapless number; save; audit.
 * Any failure rolls everything back — no posted release, no entry, NO consumed number. SAL writes NO
 * ledger line itself — it only builds a command and calls PostingService (CLAUDE.md #1/#2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { RetentionRelease } from '../domain/retention-release';
import { NotPostedError } from '../domain/errors';
import { IPC_REPOSITORY, IpcRepository } from '../domain/ports/ipc.repository';
import {
  RETENTION_RELEASE_REPOSITORY,
  RetentionReleaseRepository,
} from '../domain/ports/retention-release.repository';
import { SALES_ACCOUNT_MAP_PORT, SalesAccountMapPort } from '../domain/ports/sales-account-map.port';

export interface ReleaseRetentionInput {
  releaseDate: string; // 'YYYY-MM-DD'
  releasedAmount?: string | number | null; // omit -> release the full held amount
  narration?: string | null;
}

export interface ReleaseRetentionResult {
  id: string;
  ipcId: string;
  entryId: string;
  entryNo: string;
  releasedAmount: string;
}

@Injectable()
export class ReleaseRetentionUseCase {
  constructor(
    @Inject(IPC_REPOSITORY) private readonly ipcs: IpcRepository,
    @Inject(RETENTION_RELEASE_REPOSITORY) private readonly releases: RetentionReleaseRepository,
    @Inject(SALES_ACCOUNT_MAP_PORT) private readonly accounts: SalesAccountMapPort,
    private readonly posting: PostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(ipcId: string, input: ReleaseRetentionInput, actor: Actor): Promise<ReleaseRetentionResult> {
    return this.uow.run(async () => {
      const ipc = await this.ipcs.findById(ipcId, actor.companyId);
      if (!ipc) throw new NotFoundError(`IPC ${ipcId} not found`);
      if (ipc.props.status !== 'POSTED') throw new NotPostedError(ipc.props.status);

      // Retention held, read INSIDE the tx: retentionAmount − Σ POSTED releases (FR-SAL-019).
      const alreadyReleased = await this.releases.sumPostedReleasedForIpc(ipcId, actor.companyId);
      const held = ipc.props.retentionAmount.minus(alreadyReleased);
      const heldFloored = held.isNegative() ? Money.zero() : held;

      const amount = input.releasedAmount ?? heldFloored.amount;

      const release = RetentionRelease.createDraft(
        this.ids.next(),
        {
          companyId: actor.companyId,
          financialYearId: actor.financialYearId,
          ipcId,
          projectId: ipc.props.projectId,
          customerId: ipc.props.customerId,
          costCentreId: ipc.props.costCentreId,
          purposeId: ipc.props.purposeId,
          releaseDate: input.releaseDate,
          releasedAmount: amount,
          narration: input.narration,
        },
        heldFloored,
      );

      const accountMap = await this.accounts.resolve(actor.companyId);
      const cmd = release.toPostingCommand(accountMap, actor.userId);
      const entry = await this.posting.post(cmd);

      release.markPosted(entry.id, entry.props.entryNo, actor.userId, this.clock.now());
      await this.releases.insert(release);
      await this.audit.record({
        action: 'POST',
        entityType: 'RetentionRelease',
        entityId: release.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });

      return {
        id: release.id,
        ipcId,
        entryId: entry.id,
        entryNo: entry.props.entryNo,
        releasedAmount: release.props.releasedAmount.toFixed(4),
      };
    });
  }
}
