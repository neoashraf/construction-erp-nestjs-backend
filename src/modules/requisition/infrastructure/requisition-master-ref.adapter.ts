/**
 * RequisitionMasterRefAdapter (INFRASTRUCTURE) — implements RequisitionMasterRefPort by reading MAS masters
 * directly (MAS exports no repositories to REQ). Enrols in the active UoW via getManager; company-scoped.
 *   - assertProjectNotClosed  → project.status = 'CLOSED' → ClosedProjectError (FR-REQ-004).
 *   - assertCostCentreActive  → cost_centre.is_active = false / missing → InactiveMasterReferenceError
 *     (any ACTIVE company CC is valid — no project restriction; FR-REQ-002).
 *   - assertGodownActiveInProject → godown inactive → InactiveMasterReferenceError; godown.project_id ≠
 *     project → GodownNotInProjectError (FR-REQ-003/-004). No-op when godownId is null.
 *   - itemBaseUom → item inactive → InactiveMasterReferenceError; else return item.base_uom (the line UoM).
 * REQ reads MAS; it re-specifies nothing (CLAUDE.md one-owner rule).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import {
  ClosedProjectError,
  GodownNotInProjectError,
  InactiveMasterReferenceError,
  NotFoundError,
} from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { RequisitionMasterRefPort } from '../domain/ports/requisition-master-ref.port';

@Injectable()
export class RequisitionMasterRefAdapter implements RequisitionMasterRefPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async assertProjectNotClosed(companyId: string, projectId: string): Promise<void> {
    const rows: Array<{ status: string }> = await getManager(this.dataSource).query(
      `SELECT status FROM project WHERE id = $1 AND company_id = $2`,
      [projectId, companyId],
    );
    if (!rows.length) throw new NotFoundError(`Project ${projectId} not found for this company`, { projectId });
    if (rows[0].status === 'CLOSED') throw new ClosedProjectError(projectId);
  }

  async assertCostCentreActive(companyId: string, costCentreId: string): Promise<void> {
    const rows: Array<{ is_active: boolean }> = await getManager(this.dataSource).query(
      `SELECT is_active FROM cost_centre WHERE id = $1 AND company_id = $2`,
      [costCentreId, companyId],
    );
    if (!rows.length) throw new NotFoundError(`Cost centre ${costCentreId} not found`, { costCentreId });
    if (!rows[0].is_active) throw new InactiveMasterReferenceError('cost centre', costCentreId);
  }

  async assertGodownActiveInProject(
    companyId: string,
    godownId: string | null,
    projectId: string,
  ): Promise<void> {
    if (!godownId) return;
    const rows: Array<{ is_active: boolean; project_id: string }> = await getManager(this.dataSource).query(
      `SELECT is_active, project_id FROM godown WHERE id = $1 AND company_id = $2`,
      [godownId, companyId],
    );
    if (!rows.length) throw new NotFoundError(`Godown ${godownId} not found`, { godownId });
    if (!rows[0].is_active) throw new InactiveMasterReferenceError('godown', godownId);
    if (rows[0].project_id !== projectId) throw new GodownNotInProjectError(godownId, projectId);
  }

  async itemBaseUom(companyId: string, itemId: string): Promise<string> {
    const rows: Array<{ is_active: boolean; base_uom: string }> = await getManager(this.dataSource).query(
      `SELECT is_active, base_uom FROM item WHERE id = $1 AND company_id = $2`,
      [itemId, companyId],
    );
    if (!rows.length) throw new NotFoundError(`Item ${itemId} not found`, { itemId });
    if (!rows[0].is_active) throw new InactiveMasterReferenceError('item', itemId);
    return rows[0].base_uom;
  }
}
