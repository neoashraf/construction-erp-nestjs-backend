/**
 * IpcQueryService — read side (skill §2.3): company-scoped IPC DTOs straight from SQL for the list/read
 * endpoints, PLUS (this brief, sales-ipc-retention-release) the real `outstandingAmount`/
 * `retentionHeldAmount` formulas, the retention-releases-for-an-IPC list, and the per-project cumulative
 * register (design §5.3/§5.4). No aggregates. Money serialises as numeric(18,4) JSON strings; dates as
 * 'YYYY-MM-DD'; timestamps ISO-8601 UTC (overview §6). PM readers are filtered to assigned projects (F4):
 * excluded silently on list, 403 on a direct fetch of an unassigned project's IPC/register.
 *
 * `outstandingAmount` = currentlyDueAmount − Σ(receipts applied to this IPC, REC's receipt_allocation view,
 * read via ReceiptAllocationPort) for a POSTED IPC (zero for DRAFT/CANCELLED). `retentionHeldAmount` =
 * retentionAmount − Σ(released_amount of POSTED retention releases for this IPC). Both are QUERIES, never
 * stored balances (FR-SAL-016, FR-SAL-019; ADR-0001 #7) — the sales-ipc-core doc comment this file used to
 * carry ("no REC receipts and no retention-release yet") is now resolved by this brief.
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
import {
  IPC_LEDGER_LINKAGE_PORT,
  IpcLedgerLinkagePort,
} from '../domain/ports/ipc-ledger-linkage.port';
import { IpcLinkageDto, buildIpcLinkage } from './ipc-linkage';

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
  /** Cancel/repost chain (FR-SAL-022), derived from the ledger; null for a DRAFT IPC. */
  linkage: IpcLinkageDto | null;
}

export interface RetentionReleaseDto {
  id: string;
  releaseDate: string;
  releasedAmount: string;
  entryNo: string | null;
  status: string;
  postedAt: string | null;
  postedBy: string | null;
}

export interface IpcRegisterRow {
  ipcId: string;
  ipcSeqNo: number;
  ipcDate: string;
  entryNo: string | null;
  certifiedAmount: string;
  currentlyDueAmount: string;
  retentionAmount: string;
  advanceRecoveredAmount: string;
  receivedAmount: string;
  outstandingAmount: string;
  cumCertified: string;
  cumBilledDue: string;
  cumRetainedHeld: string;
  cumAdvanceRecovered: string;
  cumReceived: string;
}

export interface IpcRegisterTotals {
  certified: string;
  billedDue: string;
  retainedHeld: string;
  advanceRecovered: string;
  received: string;
  outstanding: string;
}

export interface IpcRegister {
  rows: IpcRegisterRow[];
  totals: IpcRegisterTotals;
}

const ZERO4 = '0.0000';

@Injectable()
export class IpcQueryService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(IPC_LEDGER_LINKAGE_PORT) private readonly linkage: IpcLedgerLinkagePort,
  ) {}

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
    const derived = await this.derivedForMany(rows);
    return new Paginated(rows.map((r) => summaryDto(r, derived.get(r.id)!)), page, pageSize, total);
  }

  async get(id: string, actor: Actor): Promise<IpcDto | null> {
    const row = await getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return null;
    this.assertProjectVisible(actor, row.projectId);
    const derived = await this.derivedForOne(row);
    const linkage = await this.linkageForRow(row);
    return fullDto(row, derived, linkage);
  }

  /**
   * The cancel/repost chain for an IPC (FR-SAL-022), derived from the immutable ledger — no SAL linkage
   * columns. Null for a DRAFT IPC (no ledger footprint). One extra source-filtered read per `get`.
   */
  private async linkageForRow(row: IpcOrmEntity): Promise<IpcLinkageDto | null> {
    if (!row.journalEntryId) return null;
    const entries = await this.linkage.entriesForIpc(row.id, row.companyId);
    if (entries.length === 0) return null;
    return buildIpcLinkage(entries, row.journalEntryId, row.status === 'CANCELLED');
  }

  /** Per-IPC outstanding = currentlyDueAmount − Σ(receipts applied, REC) for a POSTED IPC (design §5.3). */
  async outstandingForIpc(ipcId: string, actor: Actor): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .findOne({ where: { id: ipcId, companyId: actor.companyId, deletedAt: null } as never });
    if (!row) return ZERO4;
    this.assertProjectVisible(actor, row.projectId);
    const derived = await this.derivedForOne(row);
    return derived.outstanding;
  }

  async retentionReleases(ipcId: string, actor: Actor): Promise<RetentionReleaseDto[]> {
    const ipc = await getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .findOne({ where: { id: ipcId, companyId: actor.companyId, deletedAt: null } as never });
    if (!ipc) return [];
    this.assertProjectVisible(actor, ipc.projectId);
    const rows: Array<{
      id: string;
      release_date: string;
      released_amount: string;
      entry_no: string | null;
      status: string;
      posted_at: Date | null;
      posted_by: string | null;
    }> = await getManager(this.dataSource).query(
      `SELECT id, release_date, released_amount::text, entry_no, status, posted_at, posted_by
         FROM retention_release
        WHERE ipc_id = $1 AND company_id = $2
        ORDER BY created_at ASC`,
      [ipcId, actor.companyId],
    );
    return rows.map((r) => ({
      id: r.id,
      releaseDate: r.release_date,
      releasedAmount: new Decimal(r.released_amount).toFixed(4),
      entryNo: r.entry_no,
      status: r.status,
      postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null,
      postedBy: r.posted_by,
    }));
  }

  /**
   * The per-project IPC register (design §5.4) — per-IPC rows + running cumulative totals via
   * `SUM(...) OVER (ORDER BY ipc_seq_no ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`, joined to
   * `retention_release` (released, POSTED) and REC's `receipt_allocation` view (received). All figures are
   * queries over `sales_invoice`, `retention_release`, and the ledger via `receipt_allocation` — never
   * stored running balances; they reconcile to the trial balance (FR-SAL-015).
   */
  async projectRegister(projectId: string, actor: Actor, financialYearId?: string): Promise<IpcRegister> {
    this.assertProjectVisible(actor, projectId);
    const params: unknown[] = [projectId, actor.companyId];
    let fyFilter = '';
    if (financialYearId) {
      params.push(financialYearId);
      fyFilter = `AND i.financial_year_id = $${params.length}`;
    }

    const rows: Array<{
      ipc_id: string;
      ipc_seq_no: number;
      ipc_date: string;
      entry_no: string | null;
      certified_amount: string;
      currently_due_amount: string;
      retention_amount: string;
      advance_recovered_amount: string;
      released_amount: string;
      received_amount: string;
      cum_certified: string;
      cum_billed_due: string;
      cum_retained_gross: string;
      cum_advance_recovered: string;
      cum_released: string;
      cum_received: string;
    }> = await getManager(this.dataSource).query(
      `WITH ipcs AS (
         SELECT i.id, i.ipc_seq_no, i.ipc_date, i.entry_no, i.certified_amount, i.currently_due_amount,
                i.retention_amount, i.advance_recovered_amount
           FROM sales_invoice i
          WHERE i.project_id = $1 AND i.company_id = $2 AND i.status = 'POSTED' ${fyFilter}
       ),
       released AS (
         SELECT rr.ipc_id, COALESCE(SUM(rr.released_amount), 0) AS released_amount
           FROM retention_release rr
          WHERE rr.company_id = $2 AND rr.status = 'POSTED' AND rr.ipc_id IN (SELECT id FROM ipcs)
          GROUP BY rr.ipc_id
       ),
       received AS (
         SELECT ra.ipc_id, COALESCE(SUM(ra.amount_applied), 0) AS received_amount
           FROM receipt_allocation ra
          WHERE ra.ipc_id IN (SELECT id FROM ipcs)
          GROUP BY ra.ipc_id
       )
       SELECT i.id AS ipc_id, i.ipc_seq_no, i.ipc_date, i.entry_no,
              i.certified_amount::text, i.currently_due_amount::text,
              i.retention_amount::text, i.advance_recovered_amount::text,
              COALESCE(rel.released_amount, 0)::text AS released_amount,
              COALESCE(rec.received_amount, 0)::text AS received_amount,
              SUM(i.certified_amount) OVER w::text AS cum_certified,
              SUM(i.currently_due_amount) OVER w::text AS cum_billed_due,
              SUM(i.retention_amount) OVER w::text AS cum_retained_gross,
              SUM(i.advance_recovered_amount) OVER w::text AS cum_advance_recovered,
              SUM(COALESCE(rel.released_amount, 0)) OVER w::text AS cum_released,
              SUM(COALESCE(rec.received_amount, 0)) OVER w::text AS cum_received
         FROM ipcs i
         LEFT JOIN released rel ON rel.ipc_id = i.id
         LEFT JOIN received rec ON rec.ipc_id = i.id
        WINDOW w AS (ORDER BY i.ipc_seq_no ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
        ORDER BY i.ipc_seq_no`,
      params,
    );

    const registerRows: IpcRegisterRow[] = rows.map((r) => {
      const currentlyDue = new Decimal(r.currently_due_amount);
      const received = new Decimal(r.received_amount);
      const outstanding = currentlyDue.minus(received);
      const cumRetainedGross = new Decimal(r.cum_retained_gross);
      const cumReleased = new Decimal(r.cum_released);
      return {
        ipcId: r.ipc_id,
        ipcSeqNo: r.ipc_seq_no,
        ipcDate: r.ipc_date,
        entryNo: r.entry_no,
        certifiedAmount: new Decimal(r.certified_amount).toFixed(4),
        currentlyDueAmount: currentlyDue.toFixed(4),
        // Per-row retentionAmount is this IPC's GROSS retention withheld (matches the API contract's row
        // shape); the NET held-across-the-project figure is the cumulative cumRetainedHeld column below.
        retentionAmount: new Decimal(r.retention_amount).toFixed(4),
        advanceRecoveredAmount: new Decimal(r.advance_recovered_amount).toFixed(4),
        receivedAmount: received.toFixed(4),
        outstandingAmount: (outstanding.isNegative() ? new Decimal(0) : outstanding).toFixed(4),
        cumCertified: new Decimal(r.cum_certified).toFixed(4),
        cumBilledDue: new Decimal(r.cum_billed_due).toFixed(4),
        cumRetainedHeld: cumRetainedGross.minus(cumReleased).toFixed(4),
        cumAdvanceRecovered: new Decimal(r.cum_advance_recovered).toFixed(4),
        cumReceived: new Decimal(r.cum_received).toFixed(4),
      };
    });

    const totals: IpcRegisterTotals = registerRows.length
      ? {
          certified: registerRows[registerRows.length - 1].cumCertified,
          billedDue: registerRows[registerRows.length - 1].cumBilledDue,
          retainedHeld: registerRows[registerRows.length - 1].cumRetainedHeld,
          advanceRecovered: registerRows[registerRows.length - 1].cumAdvanceRecovered,
          received: registerRows[registerRows.length - 1].cumReceived,
          outstanding: new Decimal(registerRows[registerRows.length - 1].cumBilledDue)
            .minus(new Decimal(registerRows[registerRows.length - 1].cumReceived))
            .toFixed(4),
        }
      : { certified: ZERO4, billedDue: ZERO4, retainedHeld: ZERO4, advanceRecovered: ZERO4, received: ZERO4, outstanding: ZERO4 };

    // Strip the internal helper field before returning.
    const cleanRows = registerRows.map(({ ...row }) => {
      delete (row as unknown as Record<string, unknown>)._releasedForRow;
      return row;
    });

    return { rows: cleanRows, totals };
  }

  private assertProjectVisible(actor: Actor, projectId: string): void {
    if (!actor.isUnscoped && !actor.assignedProjectIds.includes(projectId)) {
      throw new ForbiddenException('Project not assigned to this user');
    }
  }

  /** Batch-compute {outstanding, retentionHeld} for a page of IPC rows in two queries (avoids N+1). */
  private async derivedForMany(rows: IpcOrmEntity[]): Promise<Map<string, { outstanding: string; retentionHeld: string }>> {
    const result = new Map<string, { outstanding: string; retentionHeld: string }>();
    const postedIds = rows.filter((r) => r.status === 'POSTED').map((r) => r.id);
    if (postedIds.length === 0) {
      for (const r of rows) result.set(r.id, { outstanding: ZERO4, retentionHeld: ZERO4 });
      return result;
    }

    const m = getManager(this.dataSource);
    const [appliedRows, releasedRows]: [
      Array<{ ipc_id: string; applied: string }>,
      Array<{ ipc_id: string; released: string }>,
    ] = await Promise.all([
      m.query(
        `SELECT ipc_id, COALESCE(SUM(amount_applied), 0)::text AS applied
           FROM receipt_allocation WHERE ipc_id = ANY($1::uuid[]) GROUP BY ipc_id`,
        [postedIds],
      ),
      m.query(
        `SELECT ipc_id, COALESCE(SUM(released_amount), 0)::text AS released
           FROM retention_release WHERE ipc_id = ANY($1::uuid[]) AND status = 'POSTED' GROUP BY ipc_id`,
        [postedIds],
      ),
    ]);
    const appliedMap = new Map(appliedRows.map((r) => [r.ipc_id, r.applied]));
    const releasedMap = new Map(releasedRows.map((r) => [r.ipc_id, r.released]));

    for (const r of rows) {
      if (r.status !== 'POSTED') {
        result.set(r.id, { outstanding: ZERO4, retentionHeld: ZERO4 });
        continue;
      }
      const applied = new Decimal(appliedMap.get(r.id) ?? '0');
      const released = new Decimal(releasedMap.get(r.id) ?? '0');
      const outstanding = new Decimal(r.currentlyDueAmount).minus(applied);
      const held = new Decimal(r.retentionAmount).minus(released);
      result.set(r.id, {
        outstanding: (outstanding.isNegative() ? new Decimal(0) : outstanding).toFixed(4),
        retentionHeld: (held.isNegative() ? new Decimal(0) : held).toFixed(4),
      });
    }
    return result;
  }

  private async derivedForOne(row: IpcOrmEntity): Promise<{ outstanding: string; retentionHeld: string }> {
    const map = await this.derivedForMany([row]);
    return map.get(row.id)!;
  }
}

function summaryDto(r: IpcOrmEntity, derived: { outstanding: string; retentionHeld: string }): IpcSummaryDto {
  return {
    id: r.id,
    ipcSeqNo: r.ipcSeqNo,
    entryNo: r.entryNo,
    projectId: r.projectId,
    customerId: r.customerId,
    ipcDate: r.ipcDate,
    certifiedAmount: new Decimal(r.certifiedAmount).toFixed(4),
    currentlyDueAmount: new Decimal(r.currentlyDueAmount).toFixed(4),
    outstandingAmount: derived.outstanding,
    retentionHeldAmount: derived.retentionHeld,
    advanceRecoveredAmount: new Decimal(r.advanceRecoveredAmount).toFixed(4),
    status: r.status,
  };
}

function fullDto(
  r: IpcOrmEntity,
  derived: { outstanding: string; retentionHeld: string },
  linkage: IpcLinkageDto | null,
): IpcDto {
  return {
    ...summaryDto(r, derived),
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
    linkage,
  };
}
