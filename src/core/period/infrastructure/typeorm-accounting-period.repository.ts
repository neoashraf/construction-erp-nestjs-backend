/**
 * TypeOrmAccountingPeriodRepository (INFRASTRUCTURE). Enrols in the active UnitOfWork via `getManager`.
 * `findOwningForUpdate` is the post-time hot path: a date→period point lookup taken FOR UPDATE so a
 * concurrent close serialises against the in-flight post (FR-PER-005). `save` is a version-guarded
 * upsert (insert for generation, update for close/reopen).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { AccountingPeriod } from '../domain/accounting-period';
import { AccountingPeriodRepository } from '../domain/ports/accounting-period.repository';
import { AccountingPeriodMapper } from './accounting-period.mapper';
import { AccountingPeriodOrmEntity } from './accounting-period.orm-entity';

@Injectable()
export class TypeOrmAccountingPeriodRepository implements AccountingPeriodRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(AccountingPeriodOrmEntity);
  }

  async findOwningForUpdate(
    companyId: string,
    financialYearId: string,
    date: string,
  ): Promise<AccountingPeriod | null> {
    const row = await this.repo()
      .createQueryBuilder('p')
      .setLock('pessimistic_write')
      .where(
        'p.company_id = :companyId AND p.financial_year_id = :fyId AND p.start_date <= :date AND p.end_date >= :date',
        { companyId, fyId: financialYearId, date },
      )
      .getOne();
    return row ? AccountingPeriodMapper.toDomain(row) : null;
  }

  async findById(id: string, companyId: string): Promise<AccountingPeriod | null> {
    const row = await this.repo().findOne({ where: { id, companyId } });
    return row ? AccountingPeriodMapper.toDomain(row) : null;
  }

  async listByFy(companyId: string, financialYearId: string): Promise<AccountingPeriod[]> {
    const rows = await this.repo().find({
      where: { companyId, financialYearId },
      order: { startDate: 'ASC' },
    });
    return rows.map(AccountingPeriodMapper.toDomain);
  }

  async existsAnyForFy(companyId: string, financialYearId: string): Promise<boolean> {
    return (await this.repo().count({ where: { companyId, financialYearId } })) > 0;
  }

  async save(period: AccountingPeriod): Promise<void> {
    const repo = this.repo();
    const exists = await repo.findOne({ where: { id: period.id }, select: { id: true } });
    if (!exists) {
      await repo.save(AccountingPeriodMapper.toInsert(period));
      return;
    }
    const result = await repo
      .createQueryBuilder()
      .update(AccountingPeriodOrmEntity)
      .set({
        ...AccountingPeriodMapper.toUpdateSet(period),
        updatedAt: () => 'now()',
        version: () => '"version" + 1',
      })
      .where('id = :id AND version = :version', { id: period.id, version: period.version })
      .execute();
    if (!result.affected) {
      throw new OptimisticLockConflictError(`Accounting period ${period.id} was modified concurrently`, {
        id: period.id,
      });
    }
  }

  async saveMany(periods: AccountingPeriod[]): Promise<void> {
    for (const period of periods) await this.save(period);
  }

  async financialYearExists(companyId: string, financialYearId: string): Promise<boolean> {
    const rows: unknown[] = await getManager(this.dataSource).query(
      `SELECT 1 FROM financial_year WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [financialYearId, companyId],
    );
    return rows.length > 0;
  }

  async financialYearBounds(
    companyId: string,
    financialYearId: string,
  ): Promise<{ startDate: string; endDate: string } | null> {
    const rows: Array<{ start_date: string; end_date: string }> = await getManager(
      this.dataSource,
    ).query(
      `SELECT to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date
         FROM financial_year WHERE id = $1 AND company_id = $2`,
      [financialYearId, companyId],
    );
    return rows[0] ? { startDate: rows[0].start_date, endDate: rows[0].end_date } : null;
  }
}
