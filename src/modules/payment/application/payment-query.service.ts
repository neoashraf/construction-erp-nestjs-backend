/**
 * PaymentQueryService — read side: company-scoped payment DTOs straight from SQL for the list/read
 * endpoints. No aggregates. Money serialises as numeric(18,4) JSON strings; dates as 'YYYY-MM-DD';
 * timestamps ISO-8601 UTC. PM readers are project-scoped via the bank-charge project line: a payment with a
 * bank-charge project is visible to a PM assigned to it; a payment with no project line is visible to
 * unscoped (Accounts/Admin) roles only. The full DTO includes the allocations + derived allocatedAmount /
 * unallocatedAmount. (Open-payables / applied projections are OUT OF SCOPE — #28.)
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { PaymentVoucherOrmEntity } from '../infrastructure/payment-voucher.orm-entity';
import { PaymentAllocationOrmEntity } from '../infrastructure/payment-allocation.orm-entity';
import { PaymentListFilter } from '../domain/ports/payment.repository';
import { PayableType } from '../domain/allocation';
import { PaymentAllocationReadModel, PaymentApplicationRow } from '../infrastructure/payment-allocation.read-model';
import { PAYMENT_SOURCE_TYPE } from '../domain/payment-voucher';
import { VoucherLinkageDto, VoucherLinkageReader } from '../../../core/posting/read/voucher-linkage';

export interface PaymentSummaryDto {
  id: string;
  entryNo: string | null;
  paymentDate: string;
  paymentMode: string;
  partyId: string | null;
  paymentAccountId: string;
  paymentAmount: string;
  bankChargesAmount: string;
  /** Derived read-only: `Σ amountAllocated` (FR-PAY-005). Present on list rows too — contract 13 § `GET /api/payment`. */
  allocatedAmount: string;
  /** Derived read-only: `paymentAmount − allocatedAmount`, the on-account remainder (FR-PAY-005). */
  unallocatedAmount: string;
  status: string;
}

export interface PaymentAllocationDto {
  lineNo: number;
  payableType: string;
  payableId: string;
  amountAllocated: string;
  accruedAmount: string | null;
  partyId: string | null;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
}

export interface PaymentDto extends PaymentSummaryDto {
  financialYearId: string;
  chequeTxnRef: string | null;
  bankChargesProjectId: string | null;
  bankChargesCostCentreId: string | null;
  bankChargesPurposeId: string | null;
  narration: string | null;
  journalEntryId: string | null;
  postedAt: string | null;
  postedBy: string | null;
  allocations: PaymentAllocationDto[];
  version: number;
  /** Cancel/repost chain (FR-PAY-018/-019), derived from the ledger; null for a DRAFT payment. */
  linkage: VoucherLinkageDto | null;
}

export interface OpenPayableRow {
  payableType: PayableType;
  payableId: string;
  reference: string | null;
  partyId: string | null;
  originalAmount: string;
  appliedAmount: string;
  remainingOutstanding: string;
  accruedAmount: string | null;
  payableDate: string | null;
}

export interface OpenPayablesFilter {
  partyId?: string;
  payableType?: PayableType;
  financialYearId?: string;
  page?: number;
  pageSize?: number;
}

export interface AppliedToPayableDto {
  payableType: PayableType;
  payableId: string;
  originalAmount: string;
  appliedAmount: string;
  remainingOutstanding: string;
  applications: PaymentApplicationRow[];
}

/** An enumerated payable BEFORE the applied projection is joined on. */
interface EnumeratedPayable {
  payableType: PayableType;
  payableId: string;
  reference: string | null;
  partyId: string | null;
  originalAmount: Decimal;
  accruedAmount: Decimal | null;
  payableDate: string | null;
}

@Injectable()
export class PaymentQueryService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly readModel: PaymentAllocationReadModel,
    private readonly linkageReader?: VoucherLinkageReader,
  ) {}

  async list(filter: PaymentListFilter, actor: Actor): Promise<Paginated<PaymentSummaryDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(PaymentVoucherOrmEntity)
      .createQueryBuilder('p')
      .where('p.company_id = :companyId AND p.deleted_at IS NULL', { companyId: actor.companyId });

    if (filter.partyId) qb.andWhere('p.party_id = :partyId', { partyId: filter.partyId });
    if (filter.paymentAccountId) qb.andWhere('p.payment_account_id = :paymentAccountId', { paymentAccountId: filter.paymentAccountId });
    if (filter.projectId) {
      this.assertProjectVisible(actor, filter.projectId);
      qb.andWhere('p.bank_charges_project_id = :projectId', { projectId: filter.projectId });
    }
    if (filter.financialYearId) qb.andWhere('p.financial_year_id = :fyId', { fyId: filter.financialYearId });
    if (filter.paymentMode) {
      const modes = filter.paymentMode.split(',').map((s) => s.trim()).filter(Boolean);
      if (modes.length) qb.andWhere('p.payment_mode IN (:...modes)', { modes });
    }
    if (filter.status) {
      const statuses = filter.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length) qb.andWhere('p.status IN (:...statuses)', { statuses });
    }
    if (filter.dateFrom) qb.andWhere('p.payment_date >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('p.payment_date <= :dateTo', { dateTo: filter.dateTo });
    if (filter.entryNo) qb.andWhere('p.entry_no = :entryNo', { entryNo: filter.entryNo });

    // PM (scoped) sees only payments whose bank-charge project is assigned; project-less payments are hidden.
    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) return new Paginated([], page, pageSize, 0);
      qb.andWhere('p.bank_charges_project_id IN (:...assigned)', { assigned: actor.assignedProjectIds });
    }

    const [rows, total] = await qb
      .orderBy('p.payment_date', 'DESC')
      .addOrderBy('p.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    // Derived allocated/unallocated for the list columns: ONE batched GROUP BY over the
    // page's payments (contract 13 § `GET /api/payment`), not an N+1 per row.
    const allocatedByPayment = await this.readModel.allocatedForPayments(
      rows.map((r) => r.id),
      actor.companyId,
    );
    return new Paginated(
      rows.map((r) => summaryDto(r, allocatedByPayment.get(r.id) ?? new Decimal(0))),
      page,
      pageSize,
      total,
    );
  }

  async get(id: string, actor: Actor): Promise<PaymentDto | null> {
    const m = getManager(this.dataSource);
    const row = await m
      .getRepository(PaymentVoucherOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.bankChargesProjectId);
    const allocations = await m
      .getRepository(PaymentAllocationOrmEntity)
      .find({ where: { paymentVoucherId: id } });
    const linkage =
      (await this.linkageReader?.forVoucher(
        actor.companyId,
        PAYMENT_SOURCE_TYPE,
        row.id,
        row.journalEntryId,
        row.status === 'CANCELLED',
      )) ?? null;
    return fullDto(row, allocations, linkage);
  }

  /**
   * Open payables (design §5.4) — posted, not-fully-settled payables across PUR bills / HR labour / HR
   * salary, each joined to PAY's applied projection. `remainingOutstanding = originalAmount − appliedAmount`;
   * only rows with remaining > 0 are returned. PM scoping: PURCHASE_BILL/LABOUR_PAYABLE filtered by assigned
   * project; SALARY (no project) is Accounts/Admin-visible only (excluded for scoped PMs).
   */
  async openPayables(filter: OpenPayablesFilter, actor: Actor): Promise<Paginated<OpenPayableRow>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const types: PayableType[] = filter.payableType
      ? [filter.payableType]
      : ['PURCHASE_BILL', 'LABOUR_PAYABLE', 'SALARY'];

    const enumerated: EnumeratedPayable[] = [];
    if (types.includes('PURCHASE_BILL')) enumerated.push(...(await this.enumeratePurchaseBills(filter, actor)));
    if (types.includes('LABOUR_PAYABLE')) enumerated.push(...(await this.enumerateLabourPayables(filter, actor)));
    if (types.includes('SALARY')) enumerated.push(...(await this.enumerateSalary(filter, actor)));

    // Join the applied projection (one batch query per type) and keep only rows with remaining > 0.
    const open: OpenPayableRow[] = [];
    for (const type of types) {
      const ofType = enumerated.filter((e) => e.payableType === type);
      if (ofType.length === 0) continue;
      const applied = await this.readModel.appliedForPayables(
        type,
        ofType.map((e) => e.payableId),
        actor.companyId,
      );
      for (const e of ofType) {
        const appliedDec = applied.get(e.payableId) ?? new Decimal(0);
        const remaining = e.originalAmount.minus(appliedDec);
        if (remaining.lessThanOrEqualTo(0)) continue;
        open.push({
          payableType: e.payableType,
          payableId: e.payableId,
          reference: e.reference,
          partyId: e.partyId,
          originalAmount: e.originalAmount.toFixed(4),
          appliedAmount: appliedDec.toFixed(4),
          remainingOutstanding: remaining.toFixed(4),
          accruedAmount: e.accruedAmount !== null ? e.accruedAmount.toFixed(4) : null,
          payableDate: e.payableDate,
        });
      }
    }

    open.sort((a, b) => (b.payableDate ?? '').localeCompare(a.payableDate ?? ''));
    const total = open.length;
    return new Paginated(open.slice(skip, skip + take), page, pageSize, total);
  }

  /** Per-payable applied total + settlement trail (design §5.4). 404 if the payable is not in this company. */
  async appliedToPayable(payableType: PayableType, payableId: string, actor: Actor): Promise<AppliedToPayableDto> {
    const original = await this.resolveOriginalAmount(payableType, payableId, actor.companyId);
    if (original === null) {
      throw new NotFoundException(`Payable ${payableType} ${payableId} not found`);
    }
    const applied = await this.readModel.appliedTo(payableType, payableId, actor.companyId);
    const applications = await this.readModel.applicationsFor(payableType, payableId, actor.companyId);
    return {
      payableType,
      payableId,
      originalAmount: original.toFixed(4),
      appliedAmount: applied.toFixed(4),
      remainingOutstanding: original.minus(applied).toFixed(4),
      applications,
    };
  }

  private async enumeratePurchaseBills(filter: OpenPayablesFilter, actor: Actor): Promise<EnumeratedPayable[]> {
    const params: unknown[] = [actor.companyId];
    let sql = `SELECT id, entry_no, supplier_id, net_payable_amount::text AS net, bill_date::text AS bill_date
                 FROM purchase_bill
                WHERE company_id = $1 AND deleted_at IS NULL AND status = 'POSTED'`;
    if (filter.partyId) {
      params.push(filter.partyId);
      sql += ` AND supplier_id = $${params.length}`;
    }
    if (filter.financialYearId) {
      params.push(filter.financialYearId);
      sql += ` AND financial_year_id = $${params.length}`;
    }
    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) return [];
      params.push(actor.assignedProjectIds);
      sql += ` AND project_id = ANY($${params.length})`;
    }
    const rows: Array<{ id: string; entry_no: string | null; supplier_id: string; net: string; bill_date: string }> =
      await getManager(this.dataSource).query(sql, params);
    return rows.map((r) => ({
      payableType: 'PURCHASE_BILL' as const,
      payableId: r.id,
      reference: r.entry_no,
      partyId: r.supplier_id,
      originalAmount: new Decimal(r.net),
      accruedAmount: null,
      payableDate: r.bill_date,
    }));
  }

  private async enumerateLabourPayables(filter: OpenPayablesFilter, actor: Actor): Promise<EnumeratedPayable[]> {
    // Labour payables carry no party — a partyId filter excludes them entirely.
    if (filter.partyId) return [];
    const params: unknown[] = [actor.companyId];
    let sql = `SELECT id, accrual_date::text AS accrual_date, accrued_amount::text AS accrued
                 FROM labour_payable
                WHERE company_id = $1`;
    if (filter.financialYearId) {
      params.push(filter.financialYearId);
      sql += ` AND financial_year_id = $${params.length}`;
    }
    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) return [];
      params.push(actor.assignedProjectIds);
      sql += ` AND project_id = ANY($${params.length})`;
    }
    const rows: Array<{ id: string; accrual_date: string; accrued: string }> = await getManager(this.dataSource).query(
      sql,
      params,
    );
    return rows.map((r) => ({
      payableType: 'LABOUR_PAYABLE' as const,
      payableId: r.id,
      reference: r.accrual_date,
      partyId: null,
      originalAmount: new Decimal(r.accrued),
      accruedAmount: new Decimal(r.accrued),
      payableDate: r.accrual_date,
    }));
  }

  private async enumerateSalary(filter: OpenPayablesFilter, actor: Actor): Promise<EnumeratedPayable[]> {
    // Salary carries no party and no project — excluded for a party filter or a scoped (PM) actor.
    if (filter.partyId) return [];
    if (!actor.isUnscoped) return [];
    const params: unknown[] = [actor.companyId];
    let sql = `SELECT ss.id, ss.period_label, ss.period_end::text AS period_end,
                      COALESCE(SUM(sl.net_amount), 0)::text AS net
                 FROM salary_sheet ss
                 LEFT JOIN salary_sheet_line sl ON sl.salary_sheet_id = ss.id
                WHERE ss.company_id = $1 AND ss.status = 'POSTED'`;
    if (filter.financialYearId) {
      params.push(filter.financialYearId);
      sql += ` AND ss.financial_year_id = $${params.length}`;
    }
    sql += ` GROUP BY ss.id, ss.period_label, ss.period_end`;
    const rows: Array<{ id: string; period_label: string; period_end: string; net: string }> = await getManager(
      this.dataSource,
    ).query(sql, params);
    return rows.map((r) => ({
      payableType: 'SALARY' as const,
      payableId: r.id,
      reference: r.period_label,
      partyId: null,
      originalAmount: new Decimal(r.net),
      accruedAmount: null,
      payableDate: r.period_end,
    }));
  }

  /** The owning module's original/full amount for a payable, or null when it does not exist in the company. */
  private async resolveOriginalAmount(
    payableType: PayableType,
    payableId: string,
    companyId: string,
  ): Promise<Decimal | null> {
    const m = getManager(this.dataSource);
    if (payableType === 'PURCHASE_BILL') {
      const rows: Array<{ net: string }> = await m.query(
        `SELECT net_payable_amount::text AS net FROM purchase_bill WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
        [payableId, companyId],
      );
      return rows[0] ? new Decimal(rows[0].net) : null;
    }
    if (payableType === 'LABOUR_PAYABLE') {
      const rows: Array<{ accrued: string }> = await m.query(
        `SELECT accrued_amount::text AS accrued FROM labour_payable WHERE id = $1 AND company_id = $2`,
        [payableId, companyId],
      );
      return rows[0] ? new Decimal(rows[0].accrued) : null;
    }
    // SALARY
    const sheet: Array<{ id: string }> = await m.query(
      `SELECT id FROM salary_sheet WHERE id = $1 AND company_id = $2`,
      [payableId, companyId],
    );
    if (!sheet[0]) return null;
    const netRows: Array<{ net: string }> = await m.query(
      `SELECT COALESCE(SUM(net_amount), 0)::text AS net FROM salary_sheet_line WHERE salary_sheet_id = $1`,
      [payableId],
    );
    return new Decimal(netRows[0]?.net ?? '0');
  }

  private assertProjectVisible(actor: Actor, projectId: string | null): void {
    if (actor.isUnscoped) return;
    if (!projectId || !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('Project not assigned to this user');
    }
  }
}

/**
 * `allocated` is the payment's Σ amountAllocated — passed in because the list derives it
 * from one batched GROUP BY while `get` sums the allocation rows it already loaded.
 * Defaults to 0 so a payment with no allocations still renders `0.0000`, never `undefined`
 * (a missing string here reaches the FE money formatter and throws — FR-PAY-005).
 */
function summaryDto(r: PaymentVoucherOrmEntity, allocated: Decimal = new Decimal(0)): PaymentSummaryDto {
  const paymentAmount = new Decimal(r.paymentAmount);
  return {
    id: r.id,
    entryNo: r.entryNo,
    paymentDate: r.paymentDate,
    paymentMode: r.paymentMode,
    partyId: r.partyId,
    paymentAccountId: r.paymentAccountId,
    paymentAmount: paymentAmount.toFixed(4),
    bankChargesAmount: new Decimal(r.bankChargesAmount).toFixed(4),
    allocatedAmount: allocated.toFixed(4),
    unallocatedAmount: paymentAmount.minus(allocated).toFixed(4),
    status: r.status,
  };
}

function fullDto(
  r: PaymentVoucherOrmEntity,
  allocations: PaymentAllocationOrmEntity[],
  linkage: VoucherLinkageDto | null,
): PaymentDto {
  const allocated = allocations.reduce((s, a) => s.plus(new Decimal(a.amountAllocated)), new Decimal(0));
  return {
    ...summaryDto(r, allocated),
    financialYearId: r.financialYearId,
    chequeTxnRef: r.chequeTxnRef,
    bankChargesProjectId: r.bankChargesProjectId,
    bankChargesCostCentreId: r.bankChargesCostCentreId,
    bankChargesPurposeId: r.bankChargesPurposeId,
    narration: r.narration,
    journalEntryId: r.journalEntryId,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedBy: r.postedBy,
    allocations: allocations
      .slice()
      .sort((x, y) => x.lineNo - y.lineNo)
      .map((a) => ({
        lineNo: a.lineNo,
        payableType: a.payableType,
        payableId: a.payableId,
        amountAllocated: new Decimal(a.amountAllocated).toFixed(4),
        accruedAmount: a.accruedAmount !== null ? new Decimal(a.accruedAmount).toFixed(4) : null,
        partyId: a.partyId,
        projectId: a.projectId,
        costCentreId: a.costCentreId,
        purposeId: a.purposeId,
      })),
    version: r.version,
    linkage,
  };
}
