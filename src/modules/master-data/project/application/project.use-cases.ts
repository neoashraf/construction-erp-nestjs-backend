/**
 * Project use cases (FR-MAS-005/006). Create, update (project_code immutable once referenced by a
 * transaction), and the status state-machine transition. Audit on every mutation.
 *
 * NOTE: customer_id (Party) / project_manager_id (User) cross-company validation lands when those
 * masters exist (parties brief / AUD); referenced here by id only.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ImmutableProjectCodeError, NotFoundError } from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { CLOCK, Clock } from '../../../../common/ports/clock.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService, AuditAction } from '../../../../core/audit/application/audit.port';
import { assertVersion } from '../../application/optimistic-lock';
import { Project, ProjectStatusAction } from '../domain/project';
import { TypeOrmProjectRepository } from '../infrastructure/typeorm-project.repository';

export interface CreateProjectInput {
  projectCode: string;
  name: string;
  location?: string | null;
  customerId: string;
  projectManagerId: string;
  startDate: string;
  expectedEndDate: string;
}

@Injectable()
export class CreateProjectUseCase {
  constructor(
    private readonly repo: TypeOrmProjectRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  async execute(input: CreateProjectInput, actor: Actor): Promise<{ id: string }> {
    const project = Project.create({ companyId: actor.companyId, ...input }, this.ids);
    await this.uow.run(async () => {
      await this.repo.insert(project);
      await rec(this.audit, 'CREATE', project.id, actor);
    });
    return { id: project.id };
  }
}

export interface UpdateProjectInput {
  name?: string;
  location?: string | null;
  customerId?: string;
  projectManagerId?: string;
  expectedEndDate?: string;
  projectCode?: string;
}

@Injectable()
export class UpdateProjectUseCase {
  constructor(
    private readonly repo: TypeOrmProjectRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(id: string, input: UpdateProjectInput, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const project = await this.repo.findById(id, actor.companyId);
      if (!project) throw new NotFoundError(`Project ${id} not found`);
      assertVersion(project.version, version, 'Project', id);
      if (input.projectCode !== undefined && input.projectCode !== project.props.projectCode) {
        if (await this.repo.isReferencedByTransaction(id)) throw new ImmutableProjectCodeError();
      }
      project.update(input);
      await this.repo.update(project, version);
      await rec(this.audit, 'UPDATE', id, actor);
    });
  }
}

@Injectable()
export class ChangeProjectStatusUseCase {
  constructor(
    private readonly repo: TypeOrmProjectRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  async execute(id: string, action: ProjectStatusAction, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const project = await this.repo.findById(id, actor.companyId);
      if (!project) throw new NotFoundError(`Project ${id} not found`);
      assertVersion(project.version, version, 'Project', id);
      project.changeStatus(action, this.clock);
      await this.repo.update(project, version);
      await rec(this.audit, 'UPDATE', id, actor, { event: action === 'close' ? 'ProjectClosed' : 'ProjectStatusChanged' });
    });
  }
}

function rec(audit: AuditService, action: AuditAction, id: string, actor: Actor, after?: Record<string, unknown>): Promise<void> {
  return audit.record({ action, entityType: 'Project', entityId: id, actorId: actor.userId, companyId: actor.companyId, after });
}
