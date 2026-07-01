/**
 * Read side (skill §2.3) — company-scoped DTOs straight from SQL for the contra + journal list/detail
 * endpoints (FR-GEN-020). Money serialises as numeric(18,4) JSON strings; lines are omitted in list,
 * included in detail. No aggregates. Ordered by voucher_date desc.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Actor } from '../../../core/tenancy/tenant-context';
import { Paginated, resolvePaging } from '../../../infrastructure/http/pagination';
import {
  ContraLineOrmEntity,
  ContraVoucherOrmEntity,
} from '../infrastructure/contra-voucher.orm-entity';
import {
  JournalLineDraftOrmEntity,
  JournalVoucherOrmEntity,
} from '../infrastructure/journal-voucher.orm-entity';
import { ContraListFilter } from '../domain/ports/contra-voucher.repository';
import { JournalListFilter } from '../domain/ports/journal-voucher.repository';

export interface ContraLineDto {
  lineNo: number;
  accountId: string;
  debit: string;
  credit: string;
  narration: string | null;
}
export interface ContraVoucherDto {
  id: string;
  voucherType: 'CONTRA';
  voucherDate: string;
  narration: string | null;
  status: string;
  entryNo: string | null;
  journalEntryId: string | null;
  postedAt: string | null;
  postedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines?: ContraLineDto[];
}

export interface JournalLineDto {
  lineNo: number;
  accountId: string;
  projectId: string | null;
  costCentreId: string | null;
  purposeId: string | null;
  partyId: string | null;
  debit: string;
  credit: string;
  narration: string | null;
}
export interface JournalVoucherDto {
  id: string;
  voucherType: string;
  voucherDate: string;
  narration: string | null;
  status: string;
  entryNo: string | null;
  journalEntryId: string | null;
  postedAt: string | null;
  postedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines?: JournalLineDto[];
}

@Injectable()
export class ContraJournalQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  // ---- contra --------------------------------------------------------------------------------------

  async listContra(filter: ContraListFilter, actor: Actor): Promise<Paginated<ContraVoucherDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(ContraVoucherOrmEntity)
      .createQueryBuilder('v')
      .where('v.company_id = :companyId AND v.deleted_at IS NULL', { companyId: actor.companyId });
    if (filter.status) qb.andWhere('v.status = :status', { status: filter.status });
    if (filter.dateFrom) qb.andWhere('v.voucher_date >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('v.voucher_date <= :dateTo', { dateTo: filter.dateTo });
    if (filter.entryNo) qb.andWhere('v.entry_no = :entryNo', { entryNo: filter.entryNo });
    if (filter.accountId) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM contra_line l WHERE l.contra_voucher_id = v.id AND l.account_id = :accountId)',
        { accountId: filter.accountId },
      );
    }
    const [rows, total] = await qb
      .orderBy('v.voucher_date', 'DESC')
      .addOrderBy('v.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map((r) => contraHeaderDto(r)), page, pageSize, total);
  }

  async getContra(id: string, actor: Actor): Promise<ContraVoucherDto | null> {
    const m = getManager(this.dataSource);
    const header = await m
      .getRepository(ContraVoucherOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!header) return null;
    const lines = await m.getRepository(ContraLineOrmEntity).find({ where: { contraVoucherId: id } });
    const dto = contraHeaderDto(header);
    dto.lines = [...lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        accountId: l.accountId,
        debit: new Decimal(l.debit).toFixed(4),
        credit: new Decimal(l.credit).toFixed(4),
        narration: l.narration,
      }));
    return dto;
  }

  // ---- journal -------------------------------------------------------------------------------------

  async listJournal(filter: JournalListFilter, actor: Actor): Promise<Paginated<JournalVoucherDto>> {
    const { page, pageSize, skip, take } = resolvePaging(filter);
    const qb = getManager(this.dataSource)
      .getRepository(JournalVoucherOrmEntity)
      .createQueryBuilder('v')
      .where('v.company_id = :companyId AND v.deleted_at IS NULL', { companyId: actor.companyId });
    if (filter.voucherType) qb.andWhere('v.voucher_type = :voucherType', { voucherType: filter.voucherType });
    if (filter.status) qb.andWhere('v.status = :status', { status: filter.status });
    if (filter.dateFrom) qb.andWhere('v.voucher_date >= :dateFrom', { dateFrom: filter.dateFrom });
    if (filter.dateTo) qb.andWhere('v.voucher_date <= :dateTo', { dateTo: filter.dateTo });
    if (filter.entryNo) qb.andWhere('v.entry_no = :entryNo', { entryNo: filter.entryNo });
    for (const [key, col] of [
      ['accountId', 'account_id'],
      ['partyId', 'party_id'],
      ['projectId', 'project_id'],
    ] as const) {
      const val = filter[key];
      if (val) {
        qb.andWhere(
          `EXISTS (SELECT 1 FROM journal_line_draft l WHERE l.journal_voucher_id = v.id AND l.${col} = :${key})`,
          { [key]: val },
        );
      }
    }
    const [rows, total] = await qb
      .orderBy('v.voucher_date', 'DESC')
      .addOrderBy('v.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return new Paginated(rows.map((r) => journalHeaderDto(r)), page, pageSize, total);
  }

  async getJournal(id: string, actor: Actor): Promise<JournalVoucherDto | null> {
    const m = getManager(this.dataSource);
    const header = await m
      .getRepository(JournalVoucherOrmEntity)
      .findOne({ where: { id, companyId: actor.companyId, deletedAt: null } as never });
    if (!header) return null;
    const lines = await m.getRepository(JournalLineDraftOrmEntity).find({ where: { journalVoucherId: id } });
    const dto = journalHeaderDto(header);
    dto.lines = [...lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        accountId: l.accountId,
        projectId: l.projectId,
        costCentreId: l.costCentreId,
        purposeId: l.purposeId,
        partyId: l.partyId,
        debit: new Decimal(l.debit).toFixed(4),
        credit: new Decimal(l.credit).toFixed(4),
        narration: l.narration,
      }));
    return dto;
  }
}

function contraHeaderDto(r: ContraVoucherOrmEntity): ContraVoucherDto {
  return {
    id: r.id,
    voucherType: 'CONTRA',
    voucherDate: r.voucherDate,
    narration: r.narration,
    status: r.status,
    entryNo: r.entryNo,
    journalEntryId: r.journalEntryId,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedBy: r.postedBy,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function journalHeaderDto(r: JournalVoucherOrmEntity): JournalVoucherDto {
  return {
    id: r.id,
    voucherType: r.voucherType,
    voucherDate: r.voucherDate,
    narration: r.narration,
    status: r.status,
    entryNo: r.entryNo,
    journalEntryId: r.journalEntryId,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedBy: r.postedBy,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
