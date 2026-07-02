/**
 * PaymentQueryService — read side: company-scoped payment DTOs straight from SQL for the list/read
 * endpoints. No aggregates. Money serialises as numeric(18,4) JSON strings; dates as 'YYYY-MM-DD';
 * timestamps ISO-8601 UTC. PM readers are project-scoped via the bank-charge project line: a payment with a
 * bank-charge project is visible to a PM assigned to it; a payment with no project line is visible to
 * unscoped (Accounts/Admin) roles only. The full DTO includes the allocations + derived allocatedAmount /
 * unallocatedAmount. (Open-payables / applied projections are OUT OF SCOPE — #28.)
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { PaymentVoucherOrmEntity } from '../infrastructure/payment-voucher.orm-entity';
import { PaymentAllocationOrmEntity } from '../infrastructure/payment-allocation.orm-entity';
import { PaymentListFilter } from '../domain/ports/payment.repository';

export interface PaymentSummaryDto {
  id: string;
  entryNo: string | null;
  paymentDate: string;
  paymentMode: string;
  partyId: string | null;
  paymentAccountId: string;
  paymentAmount: string;
  bankChargesAmount: string;
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
  allocatedAmount: string;
  unallocatedAmount: string;
  allocations: PaymentAllocationDto[];
  version: number;
}

@Injectable()
export class PaymentQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

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
    return new Paginated(rows.map((r) => summaryDto(r)), page, pageSize, total);
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
    return fullDto(row, allocations);
  }

  private assertProjectVisible(actor: Actor, projectId: string | null): void {
    if (actor.isUnscoped) return;
    if (!projectId || !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('Project not assigned to this user');
    }
  }
}

function summaryDto(r: PaymentVoucherOrmEntity): PaymentSummaryDto {
  return {
    id: r.id,
    entryNo: r.entryNo,
    paymentDate: r.paymentDate,
    paymentMode: r.paymentMode,
    partyId: r.partyId,
    paymentAccountId: r.paymentAccountId,
    paymentAmount: new Decimal(r.paymentAmount).toFixed(4),
    bankChargesAmount: new Decimal(r.bankChargesAmount).toFixed(4),
    status: r.status,
  };
}

function fullDto(r: PaymentVoucherOrmEntity, allocations: PaymentAllocationOrmEntity[]): PaymentDto {
  const allocated = allocations.reduce((s, a) => s.plus(new Decimal(a.amountAllocated)), new Decimal(0));
  const unallocated = new Decimal(r.paymentAmount).minus(allocated);
  return {
    ...summaryDto(r),
    financialYearId: r.financialYearId,
    chequeTxnRef: r.chequeTxnRef,
    bankChargesProjectId: r.bankChargesProjectId,
    bankChargesCostCentreId: r.bankChargesCostCentreId,
    bankChargesPurposeId: r.bankChargesPurposeId,
    narration: r.narration,
    journalEntryId: r.journalEntryId,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedBy: r.postedBy,
    allocatedAmount: allocated.toFixed(4),
    unallocatedAmount: unallocated.toFixed(4),
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
  };
}
