/**
 * UpdateIpcDraftUseCase / DeleteIpcUseCase — edit or hard-delete an IPC DRAFT ONLY (FR-SAL-023); a
 * posted/cancelled IPC is immutable (NotDraftError → VOUCHER_POSTED_IMMUTABLE). A PATCH recomputes the
 * figures + re-caps advance server-side on the new values. Optimistic-locked by `version`. Runs inside
 * the caller's UoW; audits inside the transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { assertVersion } from '../../master-data/application/optimistic-lock';
import { EditIpc } from '../domain/ipc';
import { NotDraftError } from '../domain/errors';
import { IPC_REPOSITORY, IpcRepository } from '../domain/ports/ipc.repository';
import { IPC_CONFIG_PORT, IpcConfigPort } from '../domain/ports/ipc-config.port';
import {
  ADVANCE_BALANCE_PORT,
  AdvanceBalancePort,
} from '../domain/ports/advance-balance.port';

@Injectable()
export class UpdateIpcDraftUseCase {
  constructor(
    @Inject(IPC_REPOSITORY) private readonly repo: IpcRepository,
    @Inject(IPC_CONFIG_PORT) private readonly config: IpcConfigPort,
    @Inject(ADVANCE_BALANCE_PORT) private readonly advance: AdvanceBalancePort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, patch: EditIpc, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const ipc = await this.repo.findById(id, actor.companyId);
      if (!ipc) throw new NotFoundError(`IPC ${id} not found`);
      assertVersion(ipc.version, version, 'SalesInvoice', id);

      const rates = await this.config.rates(actor.companyId);
      const remainingAdvance = await this.advance.remainingAdvance(
        actor.companyId,
        patch.projectId ?? ipc.props.projectId,
        ipc.props.customerId,
      );
      // customerId is never edited (resolved from the project at create); strip it from the patch.
      const { customerId: _ignored, ...safePatch } = patch;
      void _ignored;
      ipc.updateDraft(safePatch, rates, remainingAdvance);
      await this.repo.save(ipc, version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'SalesInvoice',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}

@Injectable()
export class DeleteIpcUseCase {
  constructor(
    @Inject(IPC_REPOSITORY) private readonly repo: IpcRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const ipc = await this.repo.findById(id, actor.companyId);
      if (!ipc) throw new NotFoundError(`IPC ${id} not found`);
      if (ipc.props.status !== 'DRAFT') throw new NotDraftError(ipc.props.status);
      await this.repo.softDelete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE',
        entityType: 'SalesInvoice',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
