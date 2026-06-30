/**
 * AccountGroup use cases (FR-MAS-017). Create / update (rename + reparent) the typed account-group
 * hierarchy. Cross-company parent rejected (FR-MAS-028); audit on every mutation via the core
 * AuditService seam.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CrossCompanyReferenceError, NotFoundError, ValidationError } from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService, AuditAction } from '../../../../core/audit/application/audit.port';
import { assertVersion } from '../../application/optimistic-lock';
import { AccountGroup } from '../domain/account-group';
import { TypeOrmAccountGroupRepository } from '../infrastructure/typeorm-account-group.repository';

@Injectable()
export class CreateAccountGroupUseCase {
  constructor(
    private readonly repo: TypeOrmAccountGroupRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  async execute(
    input: { name: string; parentGroupId?: string | null; type: string },
    actor: Actor,
  ): Promise<{ id: string }> {
    return this.uow.run(async () => {
      if (input.parentGroupId) {
        const parentType = await this.repo.typeOf(input.parentGroupId, actor.companyId);
        if (!parentType) {
          throw new CrossCompanyReferenceError('parent account group does not belong to the company', {
            parentGroupId: input.parentGroupId,
          });
        }
      }
      const group = AccountGroup.create({ companyId: actor.companyId, ...input }, this.ids);
      await this.repo.insert(group);
      await rec(this.audit, 'CREATE', group.id, actor);
      return { id: group.id };
    });
  }
}

@Injectable()
export class UpdateAccountGroupUseCase {
  constructor(
    private readonly repo: TypeOrmAccountGroupRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(
    id: string,
    input: { name?: string; parentGroupId?: string | null },
    version: number,
    actor: Actor,
  ): Promise<void> {
    await this.uow.run(async () => {
      const group = await this.repo.findById(id, actor.companyId);
      if (!group) throw new NotFoundError(`Account group ${id} not found`);
      assertVersion(group.version, version, 'AccountGroup', id);
      if (input.parentGroupId) {
        if (input.parentGroupId === id) throw new ValidationError('An account group cannot be its own parent', { id });
        const parentType = await this.repo.typeOf(input.parentGroupId, actor.companyId);
        if (!parentType) {
          throw new CrossCompanyReferenceError('parent account group does not belong to the company', {
            parentGroupId: input.parentGroupId,
          });
        }
      }
      group.update(input);
      await this.repo.update(group, version);
      await rec(this.audit, 'UPDATE', id, actor);
    });
  }
}

function rec(audit: AuditService, action: AuditAction, id: string, actor: Actor): Promise<void> {
  return audit.record({ action, entityType: 'AccountGroup', entityId: id, actorId: actor.userId, companyId: actor.companyId });
}
