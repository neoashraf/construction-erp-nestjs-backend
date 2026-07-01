/**
 * TypeOrmSalarySheetRepository (INFRASTRUCTURE) — persists the SalarySheet aggregate + its lines. Enrols in
 * the active UnitOfWork via getManager. Every method is companyId-scoped (F3). `findByIdForUpdate` takes a
 * pessimistic row lock inside a mutating UoW (anti-double-post, mirrors TypeOrmEmployeeRepository /
 * TypeOrmAttendanceRepository); `save` bumps `version` under the optimistic-lock check and upserts every
 * line (line edits/bulk-apply always go through the aggregate, so re-persisting the full line set on every
 * save keeps the mapper the single source of truth — no separate line-diffing logic).
 * `existsDraftForPeriod` backs the one-DRAFT-per-period guard (FR-HR-013; edge §12.4); the DB partial
 * unique index is the backstop for the race the app-level check can't fully close.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { SalarySheet } from '../domain/salary-sheet';
import {
  SalarySheetListFilter,
  SalarySheetRepository,
} from '../domain/ports/salary-sheet.repository';
import { SalarySheetMapper } from './salary-sheet.mapper';
import { SalarySheetOrmEntity } from './salary-sheet.orm-entity';
import { SalarySheetLineOrmEntity } from './salary-sheet-line.orm-entity';

@Injectable()
export class TypeOrmSalarySheetRepository implements SalarySheetRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(sheet: SalarySheet): Promise<void> {
    const manager = getManager(this.dataSource);
    const row = SalarySheetMapper.toOrm(sheet);
    row.version = 1;
    await manager.getRepository(SalarySheetOrmEntity).insert(row);
    if (sheet.lines.length) {
      await manager
        .getRepository(SalarySheetLineOrmEntity)
        .insert(sheet.lines.map((l) => SalarySheetMapper.lineToOrm(sheet.id, l)));
    }
  }

  async save(sheet: SalarySheet, expectedVersion: number): Promise<void> {
    const manager = getManager(this.dataSource);
    const row = SalarySheetMapper.toOrm(sheet);
    const res = await manager
      .getRepository(SalarySheetOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        status: row.status,
        salaryEntryId: row.salaryEntryId,
        postedAt: row.postedAt,
        postedBy: row.postedBy,
        version: expectedVersion + 1,
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: row.id,
        companyId: row.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`Salary sheet ${row.id} was modified concurrently`, { id: row.id });
    }
    // Re-persist the full line set (line edits/bulk-apply always flow through the aggregate).
    for (const line of sheet.lines) {
      const lineRow = SalarySheetMapper.lineToOrm(sheet.id, line);
      await manager
        .getRepository(SalarySheetLineOrmEntity)
        .createQueryBuilder()
        .update()
        .set({
          allowances: lineRow.allowances,
          tds: lineRow.tds,
          pf: lineRow.pf,
          advanceRecovery: lineRow.advanceRecovery,
          otherDeductions: lineRow.otherDeductions,
          netAmount: lineRow.netAmount,
          version: () => 'version + 1',
        })
        .where('id = :id AND salary_sheet_id = :sheetId', { id: lineRow.id, sheetId: sheet.id })
        .execute();
    }
  }

  async findById(id: string, companyId: string): Promise<SalarySheet | null> {
    return this.load(id, companyId, false);
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<SalarySheet | null> {
    return this.load(id, companyId, true);
  }

  async existsDraftForPeriod(
    companyId: string,
    financialYearId: string,
    periodLabel: string,
  ): Promise<boolean> {
    const count = await getManager(this.dataSource)
      .getRepository(SalarySheetOrmEntity)
      .count({ where: { companyId, financialYearId, periodLabel, status: 'DRAFT' } as never });
    return count > 0;
  }

  async list(filter: SalarySheetListFilter, companyId: string): Promise<{ rows: SalarySheetOrmEntity[]; total: number }> {
    const qb = getManager(this.dataSource)
      .getRepository(SalarySheetOrmEntity)
      .createQueryBuilder('s')
      .where('s.company_id = :companyId', { companyId });
    if (filter.financialYearId) qb.andWhere('s.financial_year_id = :fy', { fy: filter.financialYearId });
    if (filter.periodLabel) qb.andWhere('s.period_label = :pl', { pl: filter.periodLabel });
    if (filter.status) qb.andWhere('s.status = :status', { status: filter.status });
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 25));
    const [rows, total] = await qb
      .orderBy('s.period_label', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { rows, total };
  }

  private async load(id: string, companyId: string, forUpdate: boolean): Promise<SalarySheet | null> {
    const manager = getManager(this.dataSource);
    const qb = manager
      .getRepository(SalarySheetOrmEntity)
      .createQueryBuilder('s')
      .where('s.id = :id AND s.company_id = :companyId', { id, companyId });
    if (forUpdate) qb.setLock('pessimistic_write');
    const row = await qb.getOne();
    if (!row) return null;
    const lineRows = await manager
      .getRepository(SalarySheetLineOrmEntity)
      .find({ where: { salarySheetId: id } as never, order: { createdAt: 'ASC' } });
    return SalarySheetMapper.toDomain(row, lineRows);
  }
}
