/**
 * Purpose use cases (FR-MAS-011/012/013/029/033). Idempotent inline-create (returns existing on a
 * trimmed, case-insensitive match — race-safe via the unique index), rename, deactivate, reactivate.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DuplicateNameError, NotFoundError } from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService, AuditAction } from '../../../../core/audit/application/audit.port';
import { AccessPolicy } from '../../../../core/auth/domain/access-policy';
import { assertVersion } from '../../application/optimistic-lock';
import { Purpose, reqName } from '../domain/purpose';
import { TypeOrmPurposeRepository } from '../infrastructure/typeorm-purpose.repository';

@Injectable()
export class InlineCreatePurposeUseCase {
  constructor(
    private readonly repo: TypeOrmPurposeRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  /** Returns the purpose id + whether it was newly created (controller maps to 201 vs 200). */
  async execute(projectId: string, name: string, actor: Actor): Promise<{ id: string; created: boolean }> {
    const trimmed = reqName(name);
    return this.uow.run(async () => {
      const existing = await this.repo.findByNameCI(projectId, trimmed, actor.companyId);
      if (existing) return { id: existing.id, created: false };
      const purpose = Purpose.create({ companyId: actor.companyId, projectId, name: trimmed }, this.ids);
      const inserted = await this.repo.tryInsert(purpose);
      if (!inserted) {
        // concurrent duplicate insert won the race — return the now-existing row
        const winner = await this.repo.findByNameCI(projectId, trimmed, actor.companyId);
        if (!winner) throw new DuplicateNameError(trimmed, { projectId });
        return { id: winner.id, created: false };
      }
      await rec(this.audit, 'CREATE', purpose.id, actor);
      return { id: purpose.id, created: true };
    });
  }
}

@Injectable()
export class RenamePurposeUseCase {
  constructor(
    private readonly repo: TypeOrmPurposeRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(id: string, name: string, version: number, actor: Actor): Promise<void> {
    const trimmed = reqName(name);
    await this.uow.run(async () => {
      const purpose = await this.repo.findById(id, actor.companyId);
      if (!purpose) throw new NotFoundError(`Purpose ${id} not found`);
      assertVersion(purpose.version, version, 'Purpose', id);
      const clash = await this.repo.findByNameCI(purpose.props.projectId, trimmed, actor.companyId);
      if (clash && clash.id !== id) throw new DuplicateNameError(trimmed, { projectId: purpose.props.projectId });
      purpose.rename(trimmed);
      await this.repo.update(purpose, version);
      await rec(this.audit, 'UPDATE', id, actor);
    });
  }
}

@Injectable()
export class SetPurposeActiveUseCase {
  constructor(
    private readonly repo: TypeOrmPurposeRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly policy: AccessPolicy,
  ) {}
  async execute(id: string, version: number, active: boolean, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const purpose = await this.repo.findById(id, actor.companyId);
      if (!purpose) throw new NotFoundError(`Purpose ${id} not found`);
      // FR-MAS-033 / FR-AUD-014: PM may only deactivate/reactivate purposes in assigned projects.
      this.policy.assertProjectInScope(actor, purpose.props.projectId);
      assertVersion(purpose.version, version, 'Purpose', id);
      if (active) purpose.reactivate();
      else purpose.deactivate();
      await this.repo.update(purpose, version);
      await rec(this.audit, active ? 'REACTIVATE' : 'DEACTIVATE', id, actor);
    });
  }
}

function rec(audit: AuditService, action: AuditAction, id: string, actor: Actor): Promise<void> {
  return audit.record({ action, entityType: 'Purpose', entityId: id, actorId: actor.userId, companyId: actor.companyId });
}
