import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { UserProjectAssignment, UserProjectAssignmentProps } from '../domain/user-project-assignment.entity';
import { UserProjectAssignmentRepository } from '../domain/ports/user-project-assignment.repository.port';
import { UserProjectOrmEntity } from './user-project.orm-entity';

@Injectable()
export class TypeOrmUserProjectRepository implements UserProjectAssignmentRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(UserProjectOrmEntity);
  }

  async findByUserId(userId: string): Promise<UserProjectAssignment[]> {
    const rows = await this.repo().find({ where: { userId } });
    return rows.map(toDomain);
  }

  async findByUserAndProject(userId: string, projectId: string): Promise<UserProjectAssignment | null> {
    const r = await this.repo().findOne({ where: { userId, projectId } });
    return r ? toDomain(r) : null;
  }

  async replaceSet(userId: string, companyId: string, newProjectIds: string[]): Promise<{ added: string[]; removed: string[] }> {
    const existing = await this.repo().find({ where: { userId } });
    const existingIds = existing.map(r => r.projectId);

    const added = newProjectIds.filter(id => !existingIds.includes(id));
    const removed = existingIds.filter(id => !newProjectIds.includes(id));

    if (removed.length > 0) {
      for (const projectId of removed) {
        await this.repo().delete({ userId, projectId });
      }
    }
    for (const projectId of added) {
      await this.repo().insert({
        id: crypto.randomUUID(),
        userId,
        projectId,
        companyId,
        assignedAt: new Date(),
      });
    }
    return { added, removed };
  }

  async unassign(userId: string, projectId: string): Promise<void> {
    await this.repo().delete({ userId, projectId });
  }

  async save(assignment: UserProjectAssignment): Promise<void> {
    const p = assignment.props;
    await this.repo().insert({
      id: assignment.id,
      userId: p.userId,
      projectId: p.projectId,
      companyId: p.companyId,
      assignedAt: p.assignedAt,
    });
  }
}

function toDomain(r: UserProjectOrmEntity): UserProjectAssignment {
  const props: UserProjectAssignmentProps = {
    userId: r.userId,
    projectId: r.projectId,
    companyId: r.companyId,
    assignedAt: r.assignedAt,
  };
  return UserProjectAssignment.rehydrate(r.id, props);
}
