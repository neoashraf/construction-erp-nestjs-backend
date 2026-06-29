/**
 * TypeOrmCompanyRepository — CompanyRepository adapter (INFRASTRUCTURE). Enrols in the active
 * UnitOfWork transaction via `getManager` (AsyncLocalStorage). `save` is an explicit upsert: INSERT a
 * new company, or a version-guarded UPDATE (`WHERE id AND version`) that throws on a stale write
 * (FR-MAS-032). The `@VersionColumn` is bumped explicitly because QueryBuilder updates don't.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OptimisticLockConflictError } from '../../../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../../../database/database.module';
import { getManager } from '../../../../../infrastructure/unit-of-work/transaction-context';
import { Company } from '../../domain/company';
import { CompanyRepository } from '../../domain/ports/company.repository';
import { CompanyMapper } from './company.mapper';
import { CompanyOrmEntity } from './company.orm-entity';

@Injectable()
export class TypeOrmCompanyRepository implements CompanyRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(CompanyOrmEntity);
  }

  async findById(id: string): Promise<Company | null> {
    const row = await this.repo().findOne({ where: { id } });
    return row ? CompanyMapper.toDomain(row) : null;
  }

  async save(company: Company): Promise<void> {
    const repo = this.repo();
    const exists = await repo.findOne({ where: { id: company.id }, select: { id: true } });
    if (!exists) {
      await repo.save(CompanyMapper.toInsert(company));
      return;
    }
    const result = await repo
      .createQueryBuilder()
      .update(CompanyOrmEntity)
      .set({
        ...CompanyMapper.toUpdateSet(company),
        updatedAt: () => 'now()',
        version: () => '"version" + 1',
      })
      .where('id = :id AND version = :version', { id: company.id, version: company.version })
      .execute();
    if (!result.affected) {
      throw new OptimisticLockConflictError(`Company ${company.id} was modified concurrently`, {
        entityType: 'Company',
        id: company.id,
      });
    }
  }
}
