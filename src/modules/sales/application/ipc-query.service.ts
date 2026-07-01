/**
 * IpcQueryService — read side (skill §2.3): company-scoped IPC DTOs straight from SQL for the list/read
 * endpoints. No aggregates. Money serialises as numeric(18,4) JSON strings; dates as 'YYYY-MM-DD';
 * timestamps ISO-8601 UTC (overview §6). PM readers are filtered to assigned projects (F4): excluded
 * silently on list, 403 on a direct fetch of an unassigned project's IPC.
 *
 * `outstandingAmount` / `retentionHeldAmount` are derived read-only figures. This brief (sales-ipc-core)
 * has no REC receipts and no retention-release yet, so for a POSTED IPC outstanding = currentlyDue and
 * retentionHeld = retention; the receipt/release deductions and the project register are the NEXT brief
 * (sales-ipc-retention-release). DRAFT/CANCELLED IPCs report zero for both.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { IpcOrmEntity } from '../infrastructure/ipc.orm-entity';
import { IpcListFilter } from '../domain/ports/ipc.repository';

export interface IpcSummaryDto {
  id: string;
  ipcSeqNo: number;
  entryNo: string | null;
  projectId: string;
  customerId: string;
  ipcDate: string;
  certifiedAmount: string;
  currentlyDueAmount: string;
  outstandingAmount: string;
  retentionHeldAmount: string;
  advanceRecoveredAmount: string;
  status: string;
}

export interface IpcDto extends IpcSummaryDto {
  billDate: string;
  dueDate: string;
  workCompletedPct: string;
  costCentreId: string;
  purposeId: string;
  outputVatAmount: string;
  aitTdsAmount: string;
  retentionAmount: string;
  retentionRatePct: string;
  advanceRatePct: string;
  narration: string | null;
  journalEntryId: string | null;
  postedAt: string | null;
  postedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class IpcQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async list(filter: IpcListFilter, actor: Actor): Promise<Paginated<IpcSummaryDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .createQueryBuilder('i')
      .where('i.company_id = :companyId AND i.deleted_at IS NULL', { companyId: actor.companyId });

    if (filter.projectId) {
      this.assertProjectVisible(actor, filter.projectId);
      qb.andWhere('i.project_id = :projectId', { projectId: filter.projectId });
    }
    if (filter.customerId) qb.andWhere('i.customer_id = :customerId', { customerId: filter.customerId });
    if (filter.financialYearId) {
      qb.andWhere('i.financial_year_id = :fyId', { fyId: filter.financialYearId });
    }
    if (filter.status) {
      const statuses = filter.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length) qb.andWhere('i.status IN (:...statuses)', { statuses });
    }
    if (filter.dateFrom) qb.andWhere('i.ipc_date >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('i.ipc_date <= :dateTo', { dateTo: filter.dateTo });
    if (filter.entryNo) qb.andWhere('i.entry_no = :entryNo', { entryNo: filter.entryNo });

    // PM (scoped) sees only assigned projects.
    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) {
        return new Paginated([], page, pageSize, 0);
      }
      qb.andWhere('i.project_id IN (:...assigned)', { assigned: actor.assignedProjectIds });
    }

    const [rows, total] = await qb
      .orderBy('i.ipc_date', 'DESC')
      .addOrderBy('i.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map((r) => summaryDto(r)), page, pageSize, total);
  }

  async get(id: string, actor: Actor): Promise<IpcDto | null> {
    const row = await getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    return fullDto(row);
  }

  private assertProjectVisible(actor: Actor, projectId: string): void {
    if (!actor.isUnscoped && !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('Project not assigned to this user');
    }
  }
}

function derived(r: IpcOrmEntity): { outstanding: string; retentionHeld: string } {
  // No REC receipts / retention releases in this brief; POSTED outstanding = currentlyDue, held = retention.
  if (r.status === 'POSTED') {
    return {
      outstanding: new Decimal(r.currentlyDueAmount).toFixed(4),
      retentionHeld: new Decimal(r.retentionAmount).toFixed(4),
    };
  }
  return { outstanding: '0.0000', retentionHeld: '0.0000' };
}

function summaryDto(r: IpcOrmEntity): IpcSummaryDto {
  const d = derived(r);
  return {
    id: r.id,
    ipcSeqNo: r.ipcSeqNo,
    entryNo: r.entryNo,
    projectId: r.projectId,
    customerId: r.customerId,
    ipcDate: r.ipcDate,
    certifiedAmount: new Decimal(r.certifiedAmount).toFixed(4),
    currentlyDueAmount: new Decimal(r.currentlyDueAmount).toFixed(4),
    outstandingAmount: d.outstanding,
    retentionHeldAmount: d.retentionHeld,
    advanceRecoveredAmount: new Decimal(r.advanceRecoveredAmount).toFixed(4),
    status: r.status,
  };
}

function fullDto(r: IpcOrmEntity): IpcDto {
  return {
    ...summaryDto(r),
    billDate: r.billDate,
    dueDate: r.dueDate,
    workCompletedPct: new Decimal(r.workCompletedPct).toFixed(4),
    costCentreId: r.costCentreId,
    purposeId: r.purposeId,
    outputVatAmount: new Decimal(r.outputVatAmount).toFixed(4),
    aitTdsAmount: new Decimal(r.aitTdsAmount).toFixed(4),
    retentionAmount: new Decimal(r.retentionAmount).toFixed(4),
    retentionRatePct: new Decimal(r.retentionRatePct).toFixed(4),
    advanceRatePct: new Decimal(r.advanceRatePct).toFixed(4),
    narration: r.narration,
    journalEntryId: r.journalEntryId,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedBy: r.postedBy,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
