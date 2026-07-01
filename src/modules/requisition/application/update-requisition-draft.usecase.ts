/**
 * UpdateRequisitionDraftUseCase + DeleteRequisitionUseCase — edit/delete a requisition, DRAFT only
 * (FR-REQ-022, edge 6). A non-DRAFT edit/delete → VOUCHER_POSTED_IMMUTABLE (the aggregate's DRAFT guard).
 * Update re-validates masters + re-runs the CC cross-project consistency check on the replaced lines;
 * delete is a soft delete. Both inside one uow.run; project-scope-checked. Moves NO stock, posts NOTHING.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { AccessPolicy, ForbiddenScopeError } from '../../../core/auth/domain/access-policy';
import {
  TAG_CONSISTENCY_SERVICE,
  TagConsistencyService,
} from '../../../core/cost-control/domain/ports/tag-consistency.port';
import { ForbiddenError } from './errors';
import { EditRequisition, NewRequisitionLine } from '../domain/requisition';
import { RequisitionNotDraftError } from '../domain/errors';
import {
  REQUISITION_REPOSITORY,
  RequisitionRepository,
} from '../domain/ports/requisition.repository';
import {
  REQUISITION_MASTER_REF_PORT,
  RequisitionMasterRefPort,
} from '../domain/ports/requisition-master-ref.port';

/** A patch line the client supplies; the UoM is resolved server-side from the item's base UoM (MAS). */
export interface UpdateRequisitionLineInput {
  itemId: string;
  requestedQuantity: string;
}

export interface UpdateRequisitionInput {
  projectId?: string;
  costCentreId?: string;
  purposeId?: string;
  fromGodownId?: string | null;
  requiredDate?: string;
  priority?: EditRequisition['priority'];
  narration?: string | null;
  lines?: UpdateRequisitionLineInput[];
}

@Injectable()
export class UpdateRequisitionDraftUseCase {
  constructor(
    @Inject(REQUISITION_REPOSITORY) private readonly repo: RequisitionRepository,
    @Inject(REQUISITION_MASTER_REF_PORT) private readonly masters: RequisitionMasterRefPort,
    @Inject(TAG_CONSISTENCY_SERVICE) private readonly tagConsistency: TagConsistencyService,
    private readonly access: AccessPolicy,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(id: string, patch: UpdateRequisitionInput, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const req = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!req) throw new NotFoundError(`Requisition ${id} not found`);
      if (req.props.status !== 'DRAFT') throw new RequisitionNotDraftError(req.props.status);
      this.assertScope(actor, req.props.projectId);

      const projectId = patch.projectId ?? req.props.projectId;
      const purposeId = patch.purposeId ?? req.props.purposeId;
      const godownId = patch.fromGodownId !== undefined ? patch.fromGodownId : req.props.fromGodownId;

      if (patch.projectId !== undefined) this.assertScope(actor, patch.projectId);
      await this.masters.assertProjectNotClosed(actor.companyId, projectId);
      if (patch.costCentreId !== undefined) {
        await this.masters.assertCostCentreActive(actor.companyId, patch.costCentreId);
      }
      await this.masters.assertGodownActiveInProject(actor.companyId, godownId ?? null, projectId);

      const edit: EditRequisition = {
        projectId: patch.projectId,
        costCentreId: patch.costCentreId,
        purposeId: patch.purposeId,
        fromGodownId: patch.fromGodownId,
        requiredDate: patch.requiredDate,
        priority: patch.priority,
        narration: patch.narration,
      };
      let lineIds: string[] = [];
      if (patch.lines !== undefined) {
        const lines: NewRequisitionLine[] = [];
        for (const l of patch.lines) {
          const uom = await this.masters.itemBaseUom(actor.companyId, l.itemId);
          lines.push({ itemId: l.itemId, requestedQuantity: l.requestedQuantity, uom });
        }
        edit.lines = lines;
        lineIds = lines.map(() => this.ids.next());
        await this.tagConsistency.assertConsistent(
          { companyId: actor.companyId },
          lines.map(() => ({ projectId, purposeId, godownId: godownId ?? null })),
        );
      }

      req.editDraft(edit, lineIds);
      await this.repo.save(req, req.version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'Requisition',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }

  private assertScope(actor: Actor, projectId: string): void {
    try {
      this.access.assertProjectInScope(actor, projectId);
    } catch (e) {
      if (e instanceof ForbiddenScopeError) throw new ForbiddenError(e.message);
      throw e;
    }
  }
}

@Injectable()
export class DeleteRequisitionUseCase {
  constructor(
    @Inject(REQUISITION_REPOSITORY) private readonly repo: RequisitionRepository,
    private readonly access: AccessPolicy,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const req = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!req) throw new NotFoundError(`Requisition ${id} not found`);
      if (req.props.status !== 'DRAFT') throw new RequisitionNotDraftError(req.props.status);
      try {
        this.access.assertProjectInScope(actor, req.props.projectId);
      } catch (e) {
        if (e instanceof ForbiddenScopeError) throw new ForbiddenError(e.message);
        throw e;
      }
      await this.repo.softDelete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE',
        entityType: 'Requisition',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
