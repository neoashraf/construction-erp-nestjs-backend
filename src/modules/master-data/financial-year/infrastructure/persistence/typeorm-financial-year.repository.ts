/**
 * TypeOrmFinancialYearRepository — FinancialYearRepository adapter (INFRASTRUCTURE). Company-scoped:
 * every query filters by `company_id` (NFR-005). Enrols in the active UnitOfWork transaction via
 * `getManager`. `save` is an explicit upsert with a version-guarded, company-scoped UPDATE
 * (FR-MAS-032). The `(company_id) WHERE is_active` partial-unique index enforces one active FY.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OptimisticLockConflictError } from '../../../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../../../database/database.module';
import { getManager } from '../../../../../infrastructure/unit-of-work/transaction-context';
import { FinancialYear } from '../../domain/financial-year';
import { FinancialYearRepository } from '../../domain/ports/financial-year.repository';
import { FinancialYearMapper } from './financial-year.mapper';
import { FinancialYearOrmEntity } from './financial-year.orm-entity';

@Injectable()
export class TypeOrmFinancialYearRepository implements FinancialYearRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(FinancialYearOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<FinancialYear | null> {
    const row = await this.repo().findOne({ where: { id, companyId } });
    return row ? FinancialYearMapper.toDomain(row) : null;
  }

  async findActive(companyId: string): Promise<FinancialYear | null> {
    const row = await this.repo().findOne({ where: { companyId, isActive: true } });
    return row ? FinancialYearMapper.toDomain(row) : null;
  }

  async save(fy: FinancialYear, companyId: string): Promise<void> {
    const repo = this.repo();
    const exists = await repo.findOne({ where: { id: fy.id, companyId }, select: { id: true } });
    if (!exists) {
      await repo.save(FinancialYearMapper.toInsert(fy));
      return;
    }
    const result = await repo
      .createQueryBuilder()
      .update(FinancialYearOrmEntity)
      .set({
        ...FinancialYearMapper.toUpdateSet(fy),
        updatedAt: () => 'now()',
        version: () => '"version" + 1',
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: fy.id,
        companyId,
        version: fy.version,
      })
      .execute();
    if (!result.affected) {
      throw new OptimisticLockConflictError(`Financial year ${fy.id} was modified concurrently`, {
        entityType: 'FinancialYear',
        id: fy.id,
      });
    }
  }
}
