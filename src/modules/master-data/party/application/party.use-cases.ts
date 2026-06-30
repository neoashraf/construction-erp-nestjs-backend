/**
 * Party use cases (FR-MAS-022/023/024/029/033). Create / update / deactivate / reactivate. Role,
 * phone (E.164), TIN/BIN, opening_balance validation live in the domain. Audit on every mutation.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService, AuditAction } from '../../../../core/audit/application/audit.port';
import { assertVersion } from '../../application/optimistic-lock';
import { NewPartyInput, Party } from '../domain/party';
import { TypeOrmPartyRepository } from '../infrastructure/typeorm-party.repository';

export type CreatePartyInput = Omit<NewPartyInput, 'companyId'>;
export type UpdatePartyInput = Partial<CreatePartyInput>;

@Injectable()
export class CreatePartyUseCase {
  constructor(
    private readonly repo: TypeOrmPartyRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  async execute(input: CreatePartyInput, actor: Actor): Promise<{ id: string }> {
    const party = Party.create({ companyId: actor.companyId, ...input }, this.ids);
    await this.uow.run(async () => {
      await this.repo.insert(party);
      await rec(this.audit, 'CREATE', party.id, actor);
    });
    return { id: party.id };
  }
}

@Injectable()
export class UpdatePartyUseCase {
  constructor(
    private readonly repo: TypeOrmPartyRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(id: string, input: UpdatePartyInput, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const party = await this.repo.findById(id, actor.companyId);
      if (!party) throw new NotFoundError(`Party ${id} not found`);
      assertVersion(party.version, version, 'Party', id);
      party.update(input);
      await this.repo.update(party, version);
      await rec(this.audit, 'UPDATE', id, actor);
    });
  }
}

abstract class ToggleParty {
  constructor(
    protected readonly repo: TypeOrmPartyRepository,
    @Inject(AUDIT_SERVICE) protected readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) protected readonly uow: UnitOfWork,
  ) {}
  protected async toggle(id: string, version: number, actor: Actor, active: boolean, action: AuditAction): Promise<void> {
    await this.uow.run(async () => {
      const party = await this.repo.findById(id, actor.companyId);
      if (!party) throw new NotFoundError(`Party ${id} not found`);
      assertVersion(party.version, version, 'Party', id);
      if (active) party.reactivate();
      else party.deactivate();
      await this.repo.update(party, version);
      await rec(this.audit, action, id, actor);
    });
  }
}

@Injectable()
export class DeactivatePartyUseCase extends ToggleParty {
  execute(id: string, version: number, actor: Actor): Promise<void> {
    return this.toggle(id, version, actor, false, 'DEACTIVATE');
  }
}

@Injectable()
export class ReactivatePartyUseCase extends ToggleParty {
  execute(id: string, version: number, actor: Actor): Promise<void> {
    return this.toggle(id, version, actor, true, 'REACTIVATE');
  }
}

function rec(audit: AuditService, action: AuditAction, id: string, actor: Actor): Promise<void> {
  return audit.record({ action, entityType: 'Party', entityId: id, actorId: actor.userId, companyId: actor.companyId });
}
