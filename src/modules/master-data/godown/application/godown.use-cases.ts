/**
 * Godown use cases (FR-MAS-014/016/029/033). Create (rejects CLOSED / cross-company project, dup name),
 * update, deactivate, reactivate. Audit on mutation.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ClosedProjectError, CrossCompanyReferenceError, NotFoundError } from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService, AuditAction } from '../../../../core/audit/application/audit.port';
import { assertVersion } from '../../application/optimistic-lock';
import { TypeOrmProjectRepository } from '../../project/infrastructure/typeorm-project.repository';
import { Godown } from '../domain/godown';
import { TypeOrmGodownRepository } from '../infrastructure/typeorm-godown.repository';

@Injectable()
export class CreateGodownUseCase {
  constructor(
    private readonly repo: TypeOrmGodownRepository,
    private readonly projects: TypeOrmProjectRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  async execute(input: { projectId: string; name: string; location?: string | null }, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      const status = await this.projects.statusOf(input.projectId, actor.companyId);
      if (!status) throw new CrossCompanyReferenceError('project does not belong to the company', { projectId: input.projectId });
      if (status === 'CLOSED') throw new ClosedProjectError(input.projectId);
      const godown = Godown.create({ companyId: actor.companyId, ...input }, this.ids);
      await this.repo.insert(godown);
      await rec(this.audit, 'CREATE', godown.id, actor);
      return { id: godown.id };
    });
  }
}

@Injectable()
export class UpdateGodownUseCase {
  constructor(
    private readonly repo: TypeOrmGodownRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(id: string, input: { name?: string; location?: string | null }, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const g = await this.repo.findById(id, actor.companyId);
      if (!g) throw new NotFoundError(`Godown ${id} not found`);
      assertVersion(g.version, version, 'Godown', id);
      g.update(input);
      await this.repo.update(g, version);
      await rec(this.audit, 'UPDATE', id, actor);
    });
  }
}

@Injectable()
export class SetGodownActiveUseCase {
  constructor(
    private readonly repo: TypeOrmGodownRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(id: string, version: number, active: boolean, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const g = await this.repo.findById(id, actor.companyId);
      if (!g) throw new NotFoundError(`Godown ${id} not found`);
      assertVersion(g.version, version, 'Godown', id);
      if (active) g.reactivate();
      else g.deactivate();
      await this.repo.update(g, version);
      await rec(this.audit, active ? 'REACTIVATE' : 'DEACTIVATE', id, actor);
    });
  }
}

function rec(audit: AuditService, action: AuditAction, id: string, actor: Actor): Promise<void> {
  return audit.record({ action, entityType: 'Godown', entityId: id, actorId: actor.userId, companyId: actor.companyId });
}
