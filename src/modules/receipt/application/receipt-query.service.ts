/**
 * ReceiptQueryService — read side (skill §2.3): company-scoped receipt DTOs straight from SQL for the
 * list/read endpoints, plus `receiptsAppliedToIpc` (GET /api/receipt/ipc/{ipcId}, FR-REC-016/-018). No
 * aggregates. Money serialises as numeric(18,4) JSON strings; dates as 'YYYY-MM-DD'; timestamps ISO-8601
 * UTC (overview §6). PM readers are filtered to assigned projects (F4): excluded silently on list, 403 on
 * a direct fetch of an unassigned project's receipt. `ipcOutstandingAfter` / `balanceDue` are derived,
 * read-only figures fed by SAL's IpcReferencePort (REC never redefines the IPC outstanding).
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import { ReceiptOrmEntity } from '../infrastructure/receipt.orm-entity';
import { ReceiptListFilter } from '../domain/ports/receipt.repository';
import { IPC_REFERENCE_PORT, IpcReferencePort } from '../domain/ports/ipc-reference.port';

export interface ReceiptSummaryDto {
  id: string;
  entryNo: string | null;
  receiptType: string;
  receiptDate: string;
  paymentMode: string;
  partyId: string;
  projectId: string | null;
  ipcId: string | null;
  amountSettled: string;
  taxDeductedAtSource: string;
  status: string;
}

export interface ReceiptDto extends ReceiptSummaryDto {
  depositAccountId: string;
  costCentreId: string;
  purposeId: string | null;
  generalTargetAccountId: string | null;
  cashReceived: string;
  chequeTxnRef: string | null;
  narration: string | null;
  journalEntryId: string | null;
  ipcOutstandingAfter: string | null;
  postedAt: string | null;
  postedBy: string | null;
  version: number;
}

export interface ReceiptsAppliedRow {
  receiptId: string;
  entryNo: string | null;
  receiptDate: string;
  paymentMode: string;
  amountApplied: string;
  status: string;
}

export interface ReceiptsAppliedToIpc {
  rows: ReceiptsAppliedRow[];
  ipcCurrentlyDue: string;
  totalApplied: string;
  balanceDue: string;
}

@Injectable()
export class ReceiptQueryService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(IPC_REFERENCE_PORT) private readonly ipcRef: IpcReferencePort,
  ) {}

  async list(filter: ReceiptListFilter, actor: Actor): Promise<Paginated<ReceiptSummaryDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(ReceiptOrmEntity)
      .createQueryBuilder('r')
      .where('r.company_id = :companyId AND r.deleted_at IS NULL', { companyId: actor.companyId });

    if (filter.receiptType) qb.andWhere('r.receipt_type = :receiptType', { receiptType: filter.receiptType });
    if (filter.projectId) {
      this.assertProjectVisible(actor, filter.projectId);
      qb.andWhere('r.project_id = :projectId', { projectId: filter.projectId });
    }
    if (filter.customerId) qb.andWhere('r.party_id = :customerId', { customerId: filter.customerId });
    if (filter.ipcId) qb.andWhere('r.ipc_id = :ipcId', { ipcId: filter.ipcId });
    if (filter.financialYearId) qb.andWhere('r.financial_year_id = :fyId', { fyId: filter.financialYearId });
    if (filter.paymentMode) {
      const modes = filter.paymentMode.split(',').map((s) => s.trim()).filter(Boolean);
      if (modes.length) qb.andWhere('r.payment_mode IN (:...modes)', { modes });
    }
    if (filter.status) {
      const statuses = filter.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length) qb.andWhere('r.status IN (:...statuses)', { statuses });
    }
    if (filter.dateFrom) qb.andWhere('r.receipt_date >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('r.receipt_date <= :dateTo', { dateTo: filter.dateTo });
    if (filter.entryNo) qb.andWhere('r.entry_no = :entryNo', { entryNo: filter.entryNo });

    // PM (scoped) sees only assigned-project receipts; general no-project receipts are excluded for PM.
    if (!actor.isUnscoped) {
      if (actor.assignedProjectIds.length === 0) {
        return new Paginated([], page, pageSize, 0);
      }
      qb.andWhere('r.project_id IN (:...assigned)', { assigned: actor.assignedProjectIds });
    }

    const [rows, total] = await qb
      .orderBy('r.receipt_date', 'DESC')
      .addOrderBy('r.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map((r) => summaryDto(r)), page, pageSize, total);
  }

  async get(id: string, actor: Actor): Promise<ReceiptDto | null> {
    const row = await getManager(this.dataSource)
      .getRepository(ReceiptOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);

    let ipcOutstandingAfter: string | null = null;
    if (row.receiptType === 'IPC_LINKED' && row.ipcId) {
      const outstanding = await this.ipcRef.outstandingForIpc(row.ipcId, actor.companyId);
      ipcOutstandingAfter = outstanding.amount.toFixed(4);
    }
    return fullDto(row, ipcOutstandingAfter);
  }

  /** Receipts applied to one IPC + the resulting balance due (FR-REC-016, FR-REC-018). */
  async receiptsAppliedToIpc(ipcId: string, actor: Actor): Promise<ReceiptsAppliedToIpc> {
    const ipc = await this.ipcRef.findPostedIpc(ipcId, actor.companyId);
    if (!ipc) throw new NotFoundException(`IPC ${ipcId} not found`);
    this.assertProjectVisible(actor, ipc.projectId);

    const rows: Array<{
      id: string;
      entry_no: string | null;
      receipt_date: string;
      payment_mode: string;
      amount_settled: string;
      status: string;
    }> = await getManager(this.dataSource).query(
      `SELECT r.id, r.entry_no, r.receipt_date::text, r.payment_mode, r.amount_settled::text, r.status
         FROM receipt r
         JOIN journal_entry je ON je.id = r.journal_entry_id
        WHERE r.company_id = $1
          AND r.ipc_id = $2
          AND r.receipt_type = 'IPC_LINKED'
          AND r.status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM journal_entry rev WHERE rev.reversal_of = je.id)
        ORDER BY r.receipt_date ASC, r.created_at ASC`,
      [actor.companyId, ipcId],
    );

    const totalApplied = rows.reduce((s, r) => s.plus(new Decimal(r.amount_settled)), new Decimal(0));
    const balanceDue = ipc.currentlyDueAmount.amount.minus(totalApplied);

    return {
      rows: rows.map((r) => ({
        receiptId: r.id,
        entryNo: r.entry_no,
        receiptDate: r.receipt_date,
        paymentMode: r.payment_mode,
        amountApplied: new Decimal(r.amount_settled).toFixed(4),
        status: r.status,
      })),
      ipcCurrentlyDue: ipc.currentlyDueAmount.amount.toFixed(4),
      totalApplied: totalApplied.toFixed(4),
      balanceDue: balanceDue.toFixed(4),
    };
  }

  private assertProjectVisible(actor: Actor, projectId: string | null): void {
    if (!projectId) return; // a general "no project" receipt is visible to unscoped roles only
    if (!actor.isUnscoped && !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('Project not assigned to this user');
    }
  }
}

function summaryDto(r: ReceiptOrmEntity): ReceiptSummaryDto {
  return {
    id: r.id,
    entryNo: r.entryNo,
    receiptType: r.receiptType,
    receiptDate: r.receiptDate,
    paymentMode: r.paymentMode,
    partyId: r.partyId,
    projectId: r.projectId,
    ipcId: r.ipcId,
    amountSettled: new Decimal(r.amountSettled).toFixed(4),
    taxDeductedAtSource: new Decimal(r.taxDeductedAtSource).toFixed(4),
    status: r.status,
  };
}

function fullDto(r: ReceiptOrmEntity, ipcOutstandingAfter: string | null): ReceiptDto {
  return {
    ...summaryDto(r),
    depositAccountId: r.depositAccountId,
    costCentreId: r.costCentreId,
    purposeId: r.purposeId,
    generalTargetAccountId: r.generalTargetAccountId,
    cashReceived: new Decimal(r.cashReceived).toFixed(4),
    chequeTxnRef: r.chequeTxnRef,
    narration: r.narration,
    journalEntryId: r.journalEntryId,
    ipcOutstandingAfter,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedBy: r.postedBy,
    version: r.version,
  };
}
