/**
 * CreateIpcUseCase — save an IPC DRAFT (no number, no ledger impact — FR-SAL-001). Resolves the project's
 * customer (MAS; not client-supplied), the effective rates (MAS config), and the remaining advance
 * (ledger read) to cap recovery, then builds the pure Ipc aggregate (which computes retention/advance/VAT
 * and the residual currently-due). Rejects a duplicate IPC sequence within the project (FR-SAL-014).
 * Runs inside the caller's UoW; audits inside the transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { Ipc, NewIpc } from '../domain/ipc';
import { DuplicateSeqNoError } from '../domain/errors';
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

/** The create input; `customerId` is resolved server-side from the project (never client-supplied). */
export type CreateIpcInput = Omit<NewIpc, 'customerId'>;

@Injectable()
export class CreateIpcUseCase {
  constructor(
    @Inject(IPC_REPOSITORY) private readonly repo: IpcRepository,
    @Inject(SALES_ACCOUNT_MAP_PORT) private readonly accounts: SalesAccountMapPort,
    @Inject(IPC_CONFIG_PORT) private readonly config: IpcConfigPort,
    @Inject(ADVANCE_BALANCE_PORT) private readonly advance: AdvanceBalancePort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateIpcInput, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      const customerId = await this.accounts.resolveCustomer(actor.companyId, input.projectId);
      if (!customerId) {
        throw new NotFoundError(`Project ${input.projectId} not found for this company`, {
          projectId: input.projectId,
        });
      }
      if (await this.repo.existsSeqNo(actor.companyId, input.projectId, input.ipcSeqNo)) {
        throw new DuplicateSeqNoError(input.projectId, input.ipcSeqNo);
      }

      const rates = await this.config.rates(actor.companyId);
      const remainingAdvance = await this.advance.remainingAdvance(
        actor.companyId,
        input.projectId,
        customerId,
      );
      const ipc = Ipc.createDraft(
        this.ids.next(),
        actor.companyId,
        actor.financialYearId,
        { ...input, customerId },
        rates,
        remainingAdvance,
      );
      await this.repo.insert(ipc);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'SalesInvoice',
        entityId: ipc.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: ipc.id };
    });
  }
}
