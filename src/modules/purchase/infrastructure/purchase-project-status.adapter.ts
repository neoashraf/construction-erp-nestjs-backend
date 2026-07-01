/**
 * PurchaseProjectStatusAdapter (INFRASTRUCTURE) — implements PurchaseProjectStatusPort by reading MAS
 * `project.status`. Rejects a bill post against a CLOSED project (FR-PUR-014; FR-LED-019). LED ALSO
 * re-checks inside post(), so this is a friendly early guard, not the only one. Enrols in the active UoW
 * via getManager. Mirrors `HrProjectStatusAdapter` exactly.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { ClosedProjectError, NotFoundError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { PurchaseProjectStatusPort } from '../domain/ports/purchase-project-status.port';
import { ProjectOrmEntity } from '../../master-data/project/infrastructure/project.orm-entity';

@Injectable()
export class PurchaseProjectStatusAdapter implements PurchaseProjectStatusPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async assertNotClosed(companyId: string, projectId: string): Promise<void> {
    const row = await getManager(this.dataSource)
      .getRepository(ProjectOrmEntity)
      .findOne({ where: { id: projectId, companyId } });
    if (!row) throw new NotFoundError(`Project ${projectId} not found for this company`, { projectId });
    if (row.status === 'CLOSED') throw new ClosedProjectError(projectId);
  }
}
