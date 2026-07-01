/**
 * RequisitionQueryService — REQ read side (skill §2.3): company-scoped DTOs straight from SQL for the
 * list/read/approvals/outstanding endpoints. No aggregates. Money/qty serialise as numeric(18,4) JSON
 * strings; dates as 'YYYY-MM-DD'; timestamps ISO-8601 UTC (overview §6). Project-scoped readers (PM/Site
 * Engineer/Store Keeper) are filtered to assigned projects (F4): excluded silently on list, 403 on a
 * direct fetch of an unassigned project's requisition. `hasOutstanding=true` lists only requisitions with
 * a positive line balance (FR-REQ-021).
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { RequisitionApprovalOrmEntity } from '../infrastructure/requisition-approval.orm-entity';
import { RequisitionLineOrmEntity } from '../infrastructure/requisition-line.orm-entity';
import { RequisitionOrmEntity } from '../infrastructure/requisition.orm-entity';

export interface RequisitionListFilter {
  status?: string; // csv
  priority?: string; // csv
  projectId?: string;
  costCentreId?: string;
  submittedById?: string;
  requiredFrom?: string;
  requiredTo?: string;
  hasOutstanding?: boolean;
  page?: number;
  pageSize?: number;
}

export interface RequisitionLineDto {
  id: string;
  lineNo: number;
  itemId: string;
  requestedQuantity: string;
  issuedQuantity: string;
  balanceQuantity: string;
  indicativeRate: string | null;
  uom: string;
}

export interface RequisitionSummaryDto {
  id: string;
  requisitionNo: string | null;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  fromGodownId: string | null;
  requiredDate: string;
  priority: string;
  status: string;
  estimatedValue: string;
  approvalTier: string | null;
  submittedAt: string | null;
  submittedById: string | null;
  version: number;
}

export interface RequisitionDto extends RequisitionSummaryDto {
  closedAt: string | null;
  closedReason: string | null;
  narration: string | null;
  createdAt: string;
  updatedAt: string;
  lines: RequisitionLineDto[];
}

export interface RequisitionApprovalDto {
  id: string;
  decision: string;
  tier: string;
  thresholdEvaluated: string;
  estimatedValueAtReview: string;
  reason: string | null;
  decidedById: string;
  decidedAt: string;
}

export interface OutstandingLineDto {
  requisitionLineId: string;
  itemId: string;
  requestedQuantity: string;
  issuedQuantity: string;
  balanceQuantity: string;
  uom: string;
}

export interface OutstandingDto {
  requisitionId: string;
  status: string;
  lines: OutstandingLineDto[];
  totalOutstandingValueIndicative: string;
}

@Injectable()
export class RequisitionQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async list(filter: RequisitionListFilter, actor: Actor): Promise<Paginated<RequisitionSummaryDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(RequisitionOrmEntity)
      .createQueryBuilder('r')
      .where('r.company_id = :companyId AND r.deleted_at IS NULL', { companyId: actor.companyId });

    if (filter.projectId) {
      this.assertProjectVisible(actor, filter.projectId);
      qb.andWhere('r.project_id = :projectId', { projectId: filter.projectId });
    }
    if (filter.costCentreId) qb.andWhere('r.cost_centre_id = :ccId', { ccId: filter.costCentreId });
    if (filter.submittedById) qb.andWhere('r.submitted_by_id = :sub', { sub: filter.submittedById });
    if (filter.status) {
      const statuses = csv(filter.status);
      if (statuses.length) qb.andWhere('r.status IN (:...statuses)', { statuses });
    }
    if (filter.priority) {
      const priorities = csv(filter.priority);
      if (priorities.length) qb.andWhere('r.priority IN (:...priorities)', { priorities });
    }
    if (filter.requiredFrom) qb.andWhere('r.required_date >= :rf', { rf: filter.requiredFrom });
    if (filter.requiredTo) qb.andWhere('r.required_date <= :rt', { rt: filter.requiredTo });
    if (filter.hasOutstanding) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM requisition_line rl WHERE rl.requisition_id = r.id AND rl.balance_quantity > 0)`,
      );
    }

    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) return new Paginated([], page, pageSize, 0);
      qb.andWhere('r.project_id IN (:...assigned)', { assigned: actor.assignedProjectIds });
    }

    const [rows, total] = await qb
      .orderBy('r.required_date', 'ASC')
      .addOrderBy('r.priority', 'ASC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map(summaryDto), page, pageSize, total);
  }

  async get(id: string, actor: Actor): Promise<RequisitionDto | null> {
    const m = getManager(this.dataSource);
    const row = await m
      .getRepository(RequisitionOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    const lines = await m
      .getRepository(RequisitionLineOrmEntity)
      .find({ where: { requisitionId: id }, order: { lineNo: 'ASC' } });
    return fullDto(row, lines);
  }

  async approvals(id: string, actor: Actor): Promise<RequisitionApprovalDto[] | null> {
    const m = getManager(this.dataSource);
    const row = await m
      .getRepository(RequisitionOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    const approvals = await m
      .getRepository(RequisitionApprovalOrmEntity)
      .find({ where: { requisitionId: id }, order: { decidedAt: 'ASC' } });
    return approvals.map(approvalDto);
  }

  async outstanding(id: string, actor: Actor): Promise<OutstandingDto | null> {
    const m = getManager(this.dataSource);
    const row = await m
      .getRepository(RequisitionOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    const lines = await m
      .getRepository(RequisitionLineOrmEntity)
      .find({ where: { requisitionId: id }, order: { lineNo: 'ASC' } });
    let total = new Decimal(0);
    const outLines: OutstandingLineDto[] = lines.map((l) => {
      const balance = new Decimal(l.balanceQuantity);
      const rate = l.indicativeRate == null ? new Decimal(0) : new Decimal(l.indicativeRate);
      total = total.plus(balance.times(rate));
      return {
        requisitionLineId: l.id,
        itemId: l.itemId,
        requestedQuantity: new Decimal(l.requestedQuantity).toFixed(4),
        issuedQuantity: new Decimal(l.issuedQuantity).toFixed(4),
        balanceQuantity: balance.toFixed(4),
        uom: l.uom,
      };
    });
    return {
      requisitionId: id,
      status: row.status,
      lines: outLines,
      totalOutstandingValueIndicative: total.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
    };
  }

  private assertProjectVisible(actor: Actor, projectId: string): void {
    if (!actor.isUnscoped && !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('Project not assigned to this user');
    }
  }
}

function csv(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function summaryDto(r: RequisitionOrmEntity): RequisitionSummaryDto {
  return {
    id: r.id,
    requisitionNo: r.requisitionNo,
    projectId: r.projectId,
    costCentreId: r.costCentreId,
    purposeId: r.purposeId,
    fromGodownId: r.fromGodownId,
    requiredDate: r.requiredDate,
    priority: r.priority,
    status: r.status,
    estimatedValue: new Decimal(r.estimatedValue).toFixed(4),
    approvalTier: r.approvalTier,
    submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
    submittedById: r.submittedById,
    version: r.version,
  };
}

function lineDto(l: RequisitionLineOrmEntity): RequisitionLineDto {
  return {
    id: l.id,
    lineNo: l.lineNo,
    itemId: l.itemId,
    requestedQuantity: new Decimal(l.requestedQuantity).toFixed(4),
    issuedQuantity: new Decimal(l.issuedQuantity).toFixed(4),
    balanceQuantity: new Decimal(l.balanceQuantity).toFixed(4),
    indicativeRate: l.indicativeRate == null ? null : new Decimal(l.indicativeRate).toFixed(4),
    uom: l.uom,
  };
}

function fullDto(r: RequisitionOrmEntity, lines: RequisitionLineOrmEntity[]): RequisitionDto {
  return {
    ...summaryDto(r),
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    closedReason: r.closedReason,
    narration: r.narration,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lines: lines.map(lineDto),
  };
}

function approvalDto(a: RequisitionApprovalOrmEntity): RequisitionApprovalDto {
  return {
    id: a.id,
    decision: a.decision,
    tier: a.tier,
    thresholdEvaluated: new Decimal(a.thresholdEvaluated).toFixed(4),
    estimatedValueAtReview: new Decimal(a.estimatedValueAtReview).toFixed(4),
    reason: a.reason,
    decidedById: a.decidedBy,
    decidedAt: a.decidedAt.toISOString(),
  };
}
