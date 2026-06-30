/** TypeOrmProjectRepository (INFRASTRUCTURE) — company-scoped, version-guarded. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DuplicateCodeError } from '../../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { isUniqueViolation, versionedUpdate } from '../../shared/repo-helpers';
import { Project, ProjectProps, ProjectStatus } from '../domain/project';
import { DateOnly } from '../../../../common/value-objects/date-only';
import { ProjectOrmEntity } from './project.orm-entity';

@Injectable()
export class TypeOrmProjectRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(ProjectOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<Project | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  /** Project status for cross-master gates (budget/godown closed-project rejection). */
  async statusOf(id: string, companyId: string): Promise<ProjectStatus | null> {
    const r = await this.repo().findOne({ where: { id, companyId }, select: { id: true, status: true } });
    return r ? (r.status as ProjectStatus) : null;
  }

  async insert(p: Project): Promise<void> {
    try {
      await this.repo().insert(toOrm(p));
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateCodeError(p.props.projectCode);
      throw err;
    }
  }

  async update(p: Project, expectedVersion: number): Promise<void> {
    const pr = p.props;
    try {
      await versionedUpdate(this.repo(), ProjectOrmEntity, p.id, pr.companyId, expectedVersion, {
        projectCode: pr.projectCode,
        name: pr.name,
        location: pr.location,
        customerId: pr.customerId,
        projectManagerId: pr.projectManagerId,
        expectedEndDate: pr.expectedEndDate.value,
        actualEndDate: pr.actualEndDate ? pr.actualEndDate.value : null,
        status: pr.status,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateCodeError(pr.projectCode);
      throw err;
    }
  }

  /** True if any posted journal line tags this project (project_code then becomes immutable). */
  async isReferencedByTransaction(projectId: string): Promise<boolean> {
    const rows: unknown[] = await getManager(this.dataSource).query(
      `SELECT 1 FROM journal_line WHERE project_id = $1 LIMIT 1`,
      [projectId],
    );
    return rows.length > 0;
  }
}

function toDomain(r: ProjectOrmEntity): Project {
  const props: ProjectProps = {
    companyId: r.companyId,
    projectCode: r.projectCode,
    name: r.name,
    location: r.location,
    customerId: r.customerId,
    projectManagerId: r.projectManagerId,
    startDate: DateOnly.of(r.startDate),
    expectedEndDate: DateOnly.of(r.expectedEndDate),
    actualEndDate: r.actualEndDate ? DateOnly.of(r.actualEndDate) : null,
    status: r.status as ProjectStatus,
    version: r.version,
  };
  return Project.rehydrate(r.id, props);
}

function toOrm(p: Project): ProjectOrmEntity {
  const pr = p.props;
  const r = new ProjectOrmEntity();
  r.id = p.id;
  r.companyId = pr.companyId;
  r.projectCode = pr.projectCode;
  r.name = pr.name;
  r.location = pr.location;
  r.customerId = pr.customerId;
  r.projectManagerId = pr.projectManagerId;
  r.startDate = pr.startDate.value;
  r.expectedEndDate = pr.expectedEndDate.value;
  r.actualEndDate = pr.actualEndDate ? pr.actualEndDate.value : null;
  r.status = pr.status;
  return r;
}
