/**
 * StockJournalQueryService — INV read side (skill §2.3): company-scoped DTOs straight from SQL for the
 * Stock Journal list/read endpoints (FR-INV-022). No aggregates. Money/qty serialise as numeric(18,4)
 * JSON strings; dates 'YYYY-MM-DD'; timestamps ISO-8601 UTC (overview §6). Lives beside
 * `stock-ledger-query.service.ts` (both under application/, per this module's existing convention).
 * Project-scoped readers (PM/Store Keeper) are filtered to assigned projects (F4).
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { StockJournalListFilter } from '../domain/ports/stock-journal.repository';
import { StockJournalLineOrmEntity, StockJournalOrmEntity } from '../infrastructure/stock-journal.orm-entity';

export interface StockJournalLineDto {
  lineNo: number;
  side: 'OUT' | 'IN';
  godownId: string;
  itemId: string;
  quantity: string;
  rate: string | null;
  value: string | null;
  projectId: string;
  costCentreId: string;
  purposeId: string;
}

export interface StockJournalDto {
  id: string;
  entryNo: string | null;
  voucherDate: string;
  mode: string;
  status: string;
  fromGodownId: string | null;
  toGodownId: string | null;
  itemId: string;
  quantity: string;
  rate: string | null;
  value: string | null;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  issuedById: string | null;
  receivedById: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  negativeStockAuthorisedById: string | null;
  negativeStockReason: string | null;
  journalEntryId: string | null;
  narration: string | null;
  postedAt: string | null;
  postedById: string | null;
  version: number;
  lines?: StockJournalLineDto[];
}

@Injectable()
export class StockJournalQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async list(filter: StockJournalListFilter, actor: Actor): Promise<Paginated<StockJournalDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(StockJournalOrmEntity)
      .createQueryBuilder('v')
      .where('v.company_id = :companyId AND v.deleted_at IS NULL', { companyId: actor.companyId });

    if (filter.status) {
      const statuses = csv(filter.status);
      if (statuses.length) qb.andWhere('v.status IN (:...statuses)', { statuses });
    }
    if (filter.mode) {
      const modes = csv(filter.mode);
      if (modes.length) qb.andWhere('v.mode IN (:...modes)', { modes });
    }
    if (filter.projectId) {
      this.assertProjectVisible(actor, filter.projectId);
      qb.andWhere('v.project_id = :projectId', { projectId: filter.projectId });
    }
    if (filter.godownId) {
      qb.andWhere('(v.from_godown_id = :godownId OR v.to_godown_id = :godownId)', {
        godownId: filter.godownId,
      });
    }
    if (filter.itemId) qb.andWhere('v.item_id = :itemId', { itemId: filter.itemId });
    if (filter.dateFrom) qb.andWhere('v.voucher_date >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('v.voucher_date <= :dateTo', { dateTo: filter.dateTo });

    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) return new Paginated([], page, pageSize, 0);
      qb.andWhere('v.project_id IN (:...assigned)', { assigned: actor.assignedProjectIds });
    }

    const [rows, total] = await qb
      .orderBy('v.voucher_date', 'DESC')
      .addOrderBy('v.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map(headerDto), page, pageSize, total);
  }

  async get(id: string, actor: Actor): Promise<StockJournalDto | null> {
    const m = getManager(this.dataSource);
    const header = await m
      .getRepository(StockJournalOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!header) return null;
    this.assertProjectVisible(actor, header.projectId);
    const lines = await m
      .getRepository(StockJournalLineOrmEntity)
      .find({ where: { stockJournalId: id }, order: { lineNo: 'ASC' } });
    const dto = headerDto(header);
    dto.lines = lines.map(lineDto);
    return dto;
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

function headerDto(r: StockJournalOrmEntity): StockJournalDto {
  return {
    id: r.id,
    entryNo: r.entryNo,
    voucherDate: r.voucherDate,
    mode: r.mode,
    status: r.status,
    fromGodownId: r.fromGodownId,
    toGodownId: r.toGodownId,
    itemId: r.itemId,
    quantity: new Decimal(r.quantity).toFixed(4),
    rate: r.rate == null ? null : new Decimal(r.rate).toFixed(4),
    value: r.value == null ? null : new Decimal(r.value).toFixed(4),
    projectId: r.projectId,
    costCentreId: r.costCentreId,
    purposeId: r.purposeId,
    issuedById: r.issuedById,
    receivedById: r.receivedById,
    approvedById: r.approvedById,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    negativeStockAuthorisedById: r.negativeStockAuthorisedById,
    negativeStockReason: r.negativeStockReason,
    journalEntryId: r.journalEntryId,
    narration: r.narration,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedById: r.postedById,
    version: r.version,
  };
}

function lineDto(l: StockJournalLineOrmEntity): StockJournalLineDto {
  return {
    lineNo: l.lineNo,
    side: l.side as 'OUT' | 'IN',
    godownId: l.godownId,
    itemId: l.itemId,
    quantity: new Decimal(l.quantity).toFixed(4),
    rate: l.rate == null ? null : new Decimal(l.rate).toFixed(4),
    value: l.value == null ? null : new Decimal(l.value).toFixed(4),
    projectId: l.projectId,
    costCentreId: l.costCentreId,
    purposeId: l.purposeId,
  };
}
