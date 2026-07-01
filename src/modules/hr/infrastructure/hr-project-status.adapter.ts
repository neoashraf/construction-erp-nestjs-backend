/**
 * HrProjectStatusAdapter (INFRASTRUCTURE) — implements HrProjectStatusPort by reading MAS `project.status`.
 * Rejects a confirm against a CLOSED project (FR-HR-018; FR-LED-019). LED ALSO re-checks inside post(),
 * so this is a friendly early guard, not the only one. Enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { ClosedProjectError, NotFoundError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { HrProjectStatusPort } from '../domain/ports/project-status.port';
import { ProjectOrmEntity } from '../../master-data/project/infrastructure/project.orm-entity';

@Injectable()
export class HrProjectStatusAdapter implements HrProjectStatusPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async assertNotClosed(companyId: string, projectId: string): Promise<void> {
    const row = await getManager(this.dataSource)
      .getRepository(ProjectOrmEntity)
      .findOne({ where: { id: projectId, companyId } });
    if (!row) throw new NotFoundError(`Project ${projectId} not found for this company`, { projectId });
    if (row.status === 'CLOSED') throw new ClosedProjectError(projectId);
  }
}
