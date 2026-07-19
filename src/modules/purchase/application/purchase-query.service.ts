/**
 * PurchaseQueryService — read side (skill §2.3): company-scoped Purchase Bill/Order/GRN DTOs straight from
 * SQL for the list/read endpoints, plus the derived reads (design §2.6, §5.5):
 *   - `outstandingForBill` = net payable − Σ payments applied (FR-PUR-020), the payments read through the
 *     `BillPaymentReadPort` seam (PAY hasn't shipped — the Phase-1 `ZeroBillPaymentReadAdapter` returns 0;
 *     the `payment-bill-allocation` brief (#28) rebinds it);
 *   - `poMatch` — the PO→Bill→GRN three-way match per line (ordered/billed/received/open/matchStatus),
 *     computed over the voucher records via match.ts, never stored (FR-PUR-017, FR-PUR-018);
 *   - `supplierRegister` / `projectPurchaseRegister` — per-bill rows + cumulative totals (gross, VAT
 *     input, TDS, AIT, net payable, paid, outstanding), queries over the bill records that reconcile to
 *     the ledger's party+AP balance (FR-PUR-021);
 *   - derived `receivedQty`/`matchStatus` on bill lines (Σ POSTED GRN lines — the stored bill-line
 *     received_qty column is NOT trusted as a balance).
 * No aggregates. Money serialises as numeric(18,4) JSON strings; dates as 'YYYY-MM-DD'; timestamps
 * ISO-8601 UTC (overview §6). PM readers are filtered to assigned projects (F4): excluded silently on
 * list, 403 on a direct fetch of an unassigned project's bill/PO/GRN/register.
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
import { GrnOrmEntity } from '../infrastructure/grn.orm-entity';
import { GrnLineOrmEntity } from '../infrastructure/grn-line.orm-entity';
import { PurchaseRegisterReadRepo, RegisterBillRow } from '../infrastructure/purchase-register.read.repo';
import { PurchaseBillListFilter } from '../domain/ports/purchase-bill.repository';
import { PurchaseOrderListFilter } from '../domain/ports/purchase-order.repository';
import { GrnListFilter } from '../domain/ports/grn.repository';
import { BILL_PAYMENT_READ_PORT, BillPaymentReadPort } from '../domain/ports/bill-payment.read.port';
import { matchStatusOf, openQtyOf, MatchStatus } from '../domain/match';

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
  /** Derived billed-vs-received status (match.ts) — null on a non-stock line (FR-PUR-017). */
  matchStatus: MatchStatus | null;
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
  /** Expected delivery date — surfaced in the list "Expected delivery" column (FR-PUR-001). */
  expectedDeliveryDate: string | null;
  /** Σ line amounts (orderedQty × rate) — the PO commitment value for the list/mobile card (FR-PUR-001). */
  orderTotalAmount: string;
  status: string;
}

export interface PurchaseOrderDto extends PurchaseOrderSummaryDto {
  narration: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  version: number;
  lines: PurchaseOrderLineDto[];
}

// ---- GRN DTOs ----------------------------------------------------------------------------------------

export interface GrnLineDto {
  lineNo: number;
  purchaseBillLineId: string | null;
  itemId: string;
  receivedQty: string;
  rate: string;
  receivedValue: string;
  godownId: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  matchStatus: MatchStatus | null;
}

export interface GrnSummaryDto {
  id: string;
  grnRefNo: string | null;
  projectId: string;
  supplierId: string;
  purchaseOrderId: string | null;
  purchaseBillId: string | null;
  receiptDate: string;
  status: string;
}

export interface GrnDto extends GrnSummaryDto {
  receivedBy: string | null;
  narration: string | null;
  postedAt: string | null;
  postedBy: string | null;
  version: number;
  lines: GrnLineDto[];
}

// ---- match & register DTOs -----------------------------------------------------------------------------

export interface PoMatchLineDto {
  lineNo: number;
  itemId: string;
  orderedQty: string;
  billedQty: string;
  receivedQty: string;
  openQty: string;
  matchStatus: MatchStatus;
  /** Drill-down: a POSTED bill covering this PO line (its entryNo + id), else null (FR-PUR-018). */
  billRef: string | null;
  billId: string | null;
  /** Drill-down: a POSTED GRN covering this PO line (its grnRefNo + id), else null (FR-PUR-018). */
  grnRef: string | null;
  grnId: string | null;
}

/** Per-status line counts for the match summary header (advisory; derived, never stored). */
export interface PoMatchCountsDto {
  matched: number;
  underReceived: number;
  overReceived: number;
  pendingReceipt: number;
}

export interface PoMatchDto {
  poId: string;
  lines: PoMatchLineDto[];
  counts: PoMatchCountsDto;
}

export interface PurchaseRegisterRowDto {
  billId: string;
  entryNo: string | null;
  billDate: string;
  projectId: string;
  supplierId: string;
  grossAmount: string;
  vatInputAmount: string;
  tdsAmount: string;
  aitAmount: string;
  netPayableAmount: string;
  paidAmount: string;
  outstandingAmount: string;
}

export interface PurchaseRegisterTotalsDto {
  grossAmount: string;
  vatInputAmount: string;
  tdsAmount: string;
  aitAmount: string;
  netPayableAmount: string;
  paidAmount: string;
  outstandingAmount: string;
}

export interface PurchaseRegisterDto {
  rows: PurchaseRegisterRowDto[];
  totals: PurchaseRegisterTotalsDto;
}

@Injectable()
export class PurchaseQueryService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(BILL_PAYMENT_READ_PORT) private readonly payments: BillPaymentReadPort,
    private readonly registerRepo: PurchaseRegisterReadRepo,
  ) {}

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
    const items = await Promise.all(rows.map(async (r) => billSummaryDto(r, await this.outstandingOf(r))));
    return new Paginated(items, page, pageSize, total);
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
    // Derived per-line receivedQty/matchStatus — Σ POSTED GRN lines, never the stored column (FR-PUR-017).
    const received = await this.registerRepo.receivedPerBillLine(id, actor.companyId);
    return billDto(row, lines, await this.outstandingOf(row), received);
  }

  /** Per-bill outstanding = netPayableAmount − Σ(payments applied, PAY) for a POSTED bill (FR-PUR-020). */
  async outstandingForBill(billId: string, actor: Actor): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(PurchaseBillOrmEntity)
      .findOne({ where: { id: billId, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return ZERO4;
    this.assertProjectVisible(actor, row.projectId);
    return this.outstandingOf(row);
  }

  /**
   * Outstanding is a query — net payable minus PAY's applied payments through the `BillPaymentReadPort`
   * seam — never a stored balance (FR-PUR-020). Phase 1 binds `ZeroBillPaymentReadAdapter` (PAY not
   * shipped → applied = 0 → outstanding = full net payable for a POSTED bill; 0 for DRAFT/CANCELLED);
   * the `payment-bill-allocation` brief (#28) rebinds the port to PAY's real allocations.
   */
  private async outstandingOf(row: PurchaseBillOrmEntity): Promise<string> {
    if (row.status !== 'POSTED') return ZERO4;
    const applied = await this.payments.appliedToBill(row.id, row.companyId);
    return new Decimal(row.netPayableAmount).minus(applied).toFixed(4);
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

    // Σ line_amount per PO for the page, in one grouped query (the list "order total" —
    // the PO commitment value; derived, never stored). Empty page → no aggregate query.
    const totalsById = new Map<string, string>();
    if (rows.length) {
      const agg = await getManager(this.dataSource)
        .getRepository(PurchaseOrderLineOrmEntity)
        .createQueryBuilder('l')
        .select('l.purchase_order_id', 'poId')
        .addSelect('COALESCE(SUM(l.line_amount), 0)', 'total')
        .where('l.purchase_order_id IN (:...ids)', { ids: rows.map((r) => r.id) })
        .groupBy('l.purchase_order_id')
        .getRawMany<{ poId: string; total: string }>();
      for (const a of agg) totalsById.set(a.poId, new Decimal(a.total).toFixed(4));
    }

    return new Paginated(
      rows.map((r) => orderSummaryDto(r, totalsById.get(r.id) ?? '0.0000')),
      page,
      pageSize,
      total,
    );
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

  // ---- GRN ----------------------------------------------------------------------------------------------

  async listGrns(filter: GrnListFilter, actor: Actor): Promise<Paginated<GrnSummaryDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(GrnOrmEntity)
      .createQueryBuilder('g')
      .where('g.company_id = :companyId', { companyId: actor.companyId });

    if (filter.projectId) {
      this.assertProjectVisible(actor, filter.projectId);
      qb.andWhere('g.project_id = :projectId', { projectId: filter.projectId });
    }
    if (filter.supplierId) qb.andWhere('g.supplier_id = :supplierId', { supplierId: filter.supplierId });
    if (filter.purchaseBillId) qb.andWhere('g.purchase_bill_id = :billId', { billId: filter.purchaseBillId });
    if (filter.purchaseOrderId) qb.andWhere('g.purchase_order_id = :poId', { poId: filter.purchaseOrderId });
    if (filter.status) {
      const statuses = filter.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length) qb.andWhere('g.status IN (:...statuses)', { statuses });
    }
    if (filter.dateFrom) qb.andWhere('g.receipt_date >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('g.receipt_date <= :dateTo', { dateTo: filter.dateTo });

    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) return new Paginated([], page, pageSize, 0);
      qb.andWhere('g.project_id IN (:...assigned)', { assigned: actor.assignedProjectIds });
    }

    const [rows, total] = await qb
      .orderBy('g.receipt_date', 'DESC')
      .addOrderBy('g.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map(grnSummaryDto), page, pageSize, total);
  }

  async getGrn(id: string, actor: Actor): Promise<GrnDto | null> {
    const m = getManager(this.dataSource);
    const row = await m.getRepository(GrnOrmEntity).findOne({ where: { id, companyId: actor.companyId } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    const lines = await m
      .getRepository(GrnLineOrmEntity)
      .find({ where: { grnId: id }, order: { lineNo: 'ASC' } as never });
    return grnDto(row, lines);
  }

  // ---- PO → Bill → GRN three-way match (FR-PUR-017, FR-PUR-018) -------------------------------------------

  /**
   * Per PO line: orderedQty, billedQty (POSTED bills), receivedQty (POSTED GRNs), openQty
   * (billed − Σ received, floored 0) and matchStatus — ALL computed over the voucher records via
   * match.ts; nothing here is a stored running balance (AC8).
   */
  async poMatch(poId: string, actor: Actor): Promise<PoMatchDto> {
    const m = getManager(this.dataSource);
    const po = await m.getRepository(PurchaseOrderOrmEntity).findOne({ where: { id: poId, companyId: actor.companyId } as never });
    if (!po) throw new NotFoundException(`Purchase Order ${poId} not found`);
    this.assertProjectVisible(actor, po.projectId);

    const rows = await this.registerRepo.poMatchRows(poId, actor.companyId);
    const lines: PoMatchLineDto[] = rows.map((r) => {
      const billed = new Decimal(r.billedQty);
      const received = new Decimal(r.receivedQty);
      return {
        lineNo: r.lineNo,
        itemId: r.itemId,
        orderedQty: new Decimal(r.orderedQty).toFixed(4),
        billedQty: billed.toFixed(4),
        receivedQty: received.toFixed(4),
        openQty: openQtyOf(billed, received).toFixed(4),
        matchStatus: matchStatusOf(billed, received),
        billRef: r.billRef ?? null,
        billId: r.billId ?? null,
        grnRef: r.grnRef ?? null,
        grnId: r.grnId ?? null,
      };
    });
    // Advisory per-status counts for the match summary header (derived, never stored).
    const counts: PoMatchCountsDto = {
      matched: lines.filter((l) => l.matchStatus === 'MATCHED').length,
      underReceived: lines.filter((l) => l.matchStatus === 'UNDER_RECEIVED').length,
      overReceived: lines.filter((l) => l.matchStatus === 'OVER_RECEIVED').length,
      pendingReceipt: lines.filter((l) => l.matchStatus === 'PENDING_RECEIPT').length,
    };
    return { poId, lines, counts };
  }

  // ---- supplier / project purchase registers (FR-PUR-020, FR-PUR-021) --------------------------------------

  /** Per-bill rows + cumulative totals for one supplier; optional FY narrowing (API contract). */
  async supplierRegister(supplierId: string, actor: Actor, financialYearId?: string): Promise<PurchaseRegisterDto> {
    const m = getManager(this.dataSource);
    const supplier = (await m.query(`SELECT 1 FROM party WHERE id = $1 AND company_id = $2`, [
      supplierId,
      actor.companyId,
    ])) as unknown[];
    if (!supplier.length) throw new NotFoundException(`Supplier ${supplierId} not found`);

    const rows = await this.registerRepo.registerRows({
      companyId: actor.companyId,
      supplierId,
      financialYearId,
      assignedProjectIds: actor.isUnscoped ? null : actor.assignedProjectIds,
    });
    return this.toRegisterDto(rows, actor.companyId);
  }

  /** The same register shape scoped by project (FR-PUR-021). PM: 403 unless assigned. */
  async projectPurchaseRegister(projectId: string, actor: Actor, financialYearId?: string): Promise<PurchaseRegisterDto> {
    this.assertProjectVisible(actor, projectId);
    const rows = await this.registerRepo.registerRows({
      companyId: actor.companyId,
      projectId,
      financialYearId,
    });
    return this.toRegisterDto(rows, actor.companyId);
  }

  private async toRegisterDto(rows: RegisterBillRow[], companyId: string): Promise<PurchaseRegisterDto> {
    let gross = new Decimal(0);
    let vat = new Decimal(0);
    let tds = new Decimal(0);
    let ait = new Decimal(0);
    let net = new Decimal(0);
    let paid = new Decimal(0);
    let outstanding = new Decimal(0);

    const dtoRows: PurchaseRegisterRowDto[] = [];
    for (const r of rows) {
      const rowNet = new Decimal(r.netPayableAmount);
      // FR-PUR-020 — per-INDIVIDUAL-bill paid/outstanding via the PAY seam (0 until PAY ships, #28).
      const paidDec = await this.payments.appliedToBill(r.billId, companyId);
      const rowOutstanding = rowNet.minus(paidDec);
      gross = gross.plus(r.grossAmount);
      vat = vat.plus(r.vatInputAmount);
      tds = tds.plus(r.tdsAmount);
      ait = ait.plus(r.aitAmount);
      net = net.plus(rowNet);
      paid = paid.plus(paidDec);
      outstanding = outstanding.plus(rowOutstanding);
      dtoRows.push({
        billId: r.billId,
        entryNo: r.entryNo,
        billDate: r.billDate,
        projectId: r.projectId,
        supplierId: r.supplierId,
        grossAmount: new Decimal(r.grossAmount).toFixed(4),
        vatInputAmount: new Decimal(r.vatInputAmount).toFixed(4),
        tdsAmount: new Decimal(r.tdsAmount).toFixed(4),
        aitAmount: new Decimal(r.aitAmount).toFixed(4),
        netPayableAmount: rowNet.toFixed(4),
        paidAmount: paidDec.toFixed(4),
        outstandingAmount: rowOutstanding.toFixed(4),
      });
    }
    return {
      rows: dtoRows,
      totals: {
        grossAmount: gross.toFixed(4),
        vatInputAmount: vat.toFixed(4),
        tdsAmount: tds.toFixed(4),
        aitAmount: ait.toFixed(4),
        netPayableAmount: net.toFixed(4),
        paidAmount: paid.toFixed(4),
        outstandingAmount: outstanding.toFixed(4),
      },
    };
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

function billDto(
  r: PurchaseBillOrmEntity,
  lines: PurchaseBillLineOrmEntity[],
  outstanding: string,
  receivedByLine: Map<string, Decimal>,
): PurchaseBillDto {
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
    lines: lines.map((l) => {
      const received = receivedByLine.get(l.id) ?? new Decimal(0);
      return {
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
        receivedQty: received.toFixed(4),
        matchStatus: l.isStockLine ? matchStatusOf(new Decimal(l.billedQty), received) : null,
      };
    }),
  };
}

function orderSummaryDto(r: PurchaseOrderOrmEntity, orderTotalAmount: string): PurchaseOrderSummaryDto {
  return {
    id: r.id,
    poRefNo: r.poRefNo,
    projectId: r.projectId,
    supplierId: r.supplierId,
    poDate: r.poDate,
    expectedDeliveryDate: r.expectedDeliveryDate,
    orderTotalAmount,
    status: r.status,
  };
}

function orderDto(r: PurchaseOrderOrmEntity, lines: PurchaseOrderLineOrmEntity[]): PurchaseOrderDto {
  const total = lines.reduce((sum, l) => sum.plus(new Decimal(l.lineAmount)), new Decimal(0));
  return {
    ...orderSummaryDto(r, total.toFixed(4)),
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

function grnSummaryDto(r: GrnOrmEntity): GrnSummaryDto {
  return {
    id: r.id,
    grnRefNo: r.grnRefNo,
    projectId: r.projectId,
    supplierId: r.supplierId,
    purchaseOrderId: r.purchaseOrderId,
    purchaseBillId: r.purchaseBillId,
    receiptDate: r.receiptDate,
    status: r.status,
  };
}

function grnDto(r: GrnOrmEntity, lines: GrnLineOrmEntity[]): GrnDto {
  return {
    ...grnSummaryDto(r),
    receivedBy: r.receivedBy,
    narration: r.narration,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedBy: r.postedBy,
    version: r.version,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      purchaseBillLineId: l.purchaseBillLineId,
      itemId: l.itemId,
      receivedQty: new Decimal(l.receivedQty).toFixed(4),
      rate: new Decimal(l.rate).toFixed(4),
      receivedValue: new Decimal(l.receivedValue).toFixed(4),
      godownId: l.godownId,
      projectId: l.projectId,
      costCentreId: l.costCentreId,
      purposeId: l.purposeId,
      matchStatus: (l.matchStatus as MatchStatus | null) ?? null,
    })),
  };
}
