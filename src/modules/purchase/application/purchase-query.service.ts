/**
 * PurchaseQueryService — read side (skill §2.3): company-scoped Purchase Bill/Order DTOs straight from SQL
 * for the list/read endpoints, plus `outstandingForBill` (net payable - payments applied, PAY's
 * `payment_allocation`, if present — Phase-1 falls back to net payable when PAY's table doesn't exist yet).
 * No aggregates. Money serialises as numeric(18,4) JSON strings; dates as 'YYYY-MM-DD'; timestamps
 * ISO-8601 UTC (overview §6). PM readers are filtered to assigned projects (F4): excluded silently on
 * list, 403 on a direct fetch of an unassigned project's bill/PO.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { PurchaseBillOrmEntity } from '../infrastructure/purchase-bill.orm-entity';
import { PurchaseBillLineOrmEntity } from '../infrastructure/purchase-bill-line.orm-entity';
import { PurchaseOrderOrmEntity } from '../infrastructure/purchase-order.orm-entity';
import { PurchaseOrderLineOrmEntity } from '../infrastructure/purchase-order-line.orm-entity';
import { PurchaseBillListFilter } from '../domain/ports/purchase-bill.repository';
import { PurchaseOrderListFilter } from '../domain/ports/purchase-order.repository';

const ZERO4 = '0.0000';

export interface PurchaseBillLineDto {
  lineNo: number;
  itemId: string | null;
  expenseAccountId: string | null;
  isStockLine: boolean;
  billedQty: string;
  rate: string;
  lineAmount: string;
  vatInputAmount: string;
  tdsAmount: string;
  aitAmount: string;
  godownId: string | null;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  receivedQty: string;
}

export interface PurchaseBillSummaryDto {
  id: string;
  entryNo: string | null;
  projectId: string;
  supplierId: string;
  billDate: string;
  grossAmount: string;
  vatInputAmount: string;
  tdsAmount: string;
  aitAmount: string;
  netPayableAmount: string;
  outstandingAmount: string;
  status: string;
}

export interface PurchaseBillDto extends PurchaseBillSummaryDto {
  purchaseOrderId: string | null;
  supplierInvoiceRef: string | null;
  dueDate: string;
  narration: string | null;
  journalEntryId: string | null;
  postedAt: string | null;
  postedBy: string | null;
  version: number;
  lines: PurchaseBillLineDto[];
}

export interface PurchaseOrderLineDto {
  lineNo: number;
  itemId: string;
  orderedQty: string;
  rate: string;
  lineAmount: string;
  godownId: string;
  costCentreId: string;
  purposeId: string;
  billedQty: string;
  receivedQty: string;
}

export interface PurchaseOrderSummaryDto {
  id: string;
  poRefNo: string | null;
  projectId: string;
  supplierId: string;
  poDate: string;
  status: string;
}

export interface PurchaseOrderDto extends PurchaseOrderSummaryDto {
  expectedDeliveryDate: string | null;
  narration: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  version: number;
  lines: PurchaseOrderLineDto[];
}

@Injectable()
export class PurchaseQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  // ---- Purchase Bill --------------------------------------------------------------------------------

  async listBills(filter: PurchaseBillListFilter, actor: Actor): Promise<Paginated<PurchaseBillSummaryDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(PurchaseBillOrmEntity)
      .createQueryBuilder('b')
      .where('b.company_id = :companyId AND b.deleted_at IS NULL', { companyId: actor.companyId });

    if (filter.projectId) {
      this.assertProjectVisible(actor, filter.projectId);
      qb.andWhere('b.project_id = :projectId', { projectId: filter.projectId });
    }
    if (filter.supplierId) qb.andWhere('b.supplier_id = :supplierId', { supplierId: filter.supplierId });
    if (filter.purchaseOrderId) qb.andWhere('b.purchase_order_id = :poId', { poId: filter.purchaseOrderId });
    if (filter.financialYearId) qb.andWhere('b.financial_year_id = :fyId', { fyId: filter.financialYearId });
    if (filter.status) {
      const statuses = filter.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length) qb.andWhere('b.status IN (:...statuses)', { statuses });
    }
    if (filter.dateFrom) qb.andWhere('b.bill_date >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('b.bill_date <= :dateTo', { dateTo: filter.dateTo });
    if (filter.entryNo) qb.andWhere('b.entry_no = :entryNo', { entryNo: filter.entryNo });

    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) return new Paginated([], page, pageSize, 0);
      qb.andWhere('b.project_id IN (:...assigned)', { assigned: actor.assignedProjectIds });
    }

    const [rows, total] = await qb
      .orderBy('b.bill_date', 'DESC')
      .addOrderBy('b.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map((r) => billSummaryDto(r, this.outstandingSync(r))), page, pageSize, total);
  }

  async getBill(id: string, actor: Actor): Promise<PurchaseBillDto | null> {
    const m = getManager(this.dataSource);
    const row = await m
      .getRepository(PurchaseBillOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    const lines = await m
      .getRepository(PurchaseBillLineOrmEntity)
      .find({ where: { purchaseBillId: id }, order: { lineNo: 'ASC' } as never });
    return billDto(row, lines, this.outstandingSync(row));
  }

  /** Per-bill outstanding = netPayableAmount - Σ(payments applied, PAY) for a POSTED bill (FR-PUR-020). */
  async outstandingForBill(billId: string, actor: Actor): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(PurchaseBillOrmEntity)
      .findOne({ where: { id: billId, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return ZERO4;
    this.assertProjectVisible(actor, row.projectId);
    return this.outstandingSync(row);
  }

  /**
   * Outstanding is a query over `payment_allocation` (PAY), never a stored balance (FR-PUR-020). PAY has
   * not shipped as of this brief, so this degrades gracefully to the full net payable for a POSTED bill
   * (0 for DRAFT/CANCELLED) — the same "not yet applied" starting state PAY's allocations will reduce once
   * that table exists; no schema is guessed here.
   */
  private outstandingSync(row: PurchaseBillOrmEntity): string {
    if (row.status !== 'POSTED') return ZERO4;
    return new Decimal(row.netPayableAmount).toFixed(4);
  }

  // ---- Purchase Order ---------------------------------------------------------------------------------

  async listOrders(filter: PurchaseOrderListFilter, actor: Actor): Promise<Paginated<PurchaseOrderSummaryDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(PurchaseOrderOrmEntity)
      .createQueryBuilder('po')
      .where('po.company_id = :companyId', { companyId: actor.companyId });

    if (filter.projectId) {
      this.assertProjectVisible(actor, filter.projectId);
      qb.andWhere('po.project_id = :projectId', { projectId: filter.projectId });
    }
    if (filter.supplierId) qb.andWhere('po.supplier_id = :supplierId', { supplierId: filter.supplierId });
    if (filter.status) {
      const statuses = filter.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length) qb.andWhere('po.status IN (:...statuses)', { statuses });
    }
    if (filter.dateFrom) qb.andWhere('po.po_date >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('po.po_date <= :dateTo', { dateTo: filter.dateTo });

    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) return new Paginated([], page, pageSize, 0);
      qb.andWhere('po.project_id IN (:...assigned)', { assigned: actor.assignedProjectIds });
    }

    const [rows, total] = await qb
      .orderBy('po.po_date', 'DESC')
      .addOrderBy('po.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map(orderSummaryDto), page, pageSize, total);
  }

  async getOrder(id: string, actor: Actor): Promise<PurchaseOrderDto | null> {
    const m = getManager(this.dataSource);
    const row = await m.getRepository(PurchaseOrderOrmEntity).findOne({ where: { id, companyId: actor.companyId } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    const lines = await m
      .getRepository(PurchaseOrderLineOrmEntity)
      .find({ where: { purchaseOrderId: id }, order: { lineNo: 'ASC' } as never });
    return orderDto(row, lines);
  }

  private assertProjectVisible(actor: Actor, projectId: string): void {
    if (!actor.isUnscoped && !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('Project not assigned to this user');
    }
  }
}

function billSummaryDto(r: PurchaseBillOrmEntity, outstanding: string): PurchaseBillSummaryDto {
  return {
    id: r.id,
    entryNo: r.entryNo,
    projectId: r.projectId,
    supplierId: r.supplierId,
    billDate: r.billDate,
    grossAmount: new Decimal(r.grossAmount).toFixed(4),
    vatInputAmount: new Decimal(r.vatInputAmount).toFixed(4),
    tdsAmount: new Decimal(r.tdsAmount).toFixed(4),
    aitAmount: new Decimal(r.aitAmount).toFixed(4),
    netPayableAmount: new Decimal(r.netPayableAmount).toFixed(4),
    outstandingAmount: outstanding,
    status: r.status,
  };
}

function billDto(r: PurchaseBillOrmEntity, lines: PurchaseBillLineOrmEntity[], outstanding: string): PurchaseBillDto {
  return {
    ...billSummaryDto(r, outstanding),
    purchaseOrderId: r.purchaseOrderId,
    supplierInvoiceRef: r.supplierInvoiceRef,
    dueDate: r.dueDate,
    narration: r.narration,
    journalEntryId: r.journalEntryId,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedBy: r.postedBy,
    version: r.version,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      itemId: l.itemId,
      expenseAccountId: l.expenseAccountId,
      isStockLine: l.isStockLine,
      billedQty: new Decimal(l.billedQty).toFixed(4),
      rate: new Decimal(l.rate).toFixed(4),
      lineAmount: new Decimal(l.lineAmount).toFixed(4),
      vatInputAmount: new Decimal(l.vatInputAmount).toFixed(4),
      tdsAmount: new Decimal(l.tdsAmount).toFixed(4),
      aitAmount: new Decimal(l.aitAmount).toFixed(4),
      godownId: l.godownId,
      projectId: l.projectId,
      costCentreId: l.costCentreId,
      purposeId: l.purposeId,
      receivedQty: new Decimal(l.receivedQty).toFixed(4),
    })),
  };
}

function orderSummaryDto(r: PurchaseOrderOrmEntity): PurchaseOrderSummaryDto {
  return {
    id: r.id,
    poRefNo: r.poRefNo,
    projectId: r.projectId,
    supplierId: r.supplierId,
    poDate: r.poDate,
    status: r.status,
  };
}

function orderDto(r: PurchaseOrderOrmEntity, lines: PurchaseOrderLineOrmEntity[]): PurchaseOrderDto {
  return {
    ...orderSummaryDto(r),
    expectedDeliveryDate: r.expectedDeliveryDate,
    narration: r.narration,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    version: r.version,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      itemId: l.itemId,
      orderedQty: new Decimal(l.orderedQty).toFixed(4),
      rate: new Decimal(l.rate).toFixed(4),
      lineAmount: new Decimal(l.lineAmount).toFixed(4),
      godownId: l.godownId,
      costCentreId: l.costCentreId,
      purposeId: l.purposeId,
      billedQty: new Decimal(l.billedQty).toFixed(4),
      receivedQty: new Decimal(l.receivedQty).toFixed(4),
    })),
  };
}
