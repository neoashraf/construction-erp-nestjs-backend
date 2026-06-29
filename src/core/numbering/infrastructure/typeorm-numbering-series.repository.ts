/**
 * TypeOrmNumberingSeriesRepository — admin-config adapter (INFRASTRUCTURE). Enrols in the active
 * UnitOfWork transaction via `getManager`. NEVER writes `last_sequence` (that is the allocator's job);
 * `create` seeds it at 0, `updateConfig` touches only prefix/padding under an optimistic version guard.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { SeriesAlreadyExistsError } from '../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import {
  NewNumberingSeries,
  NumberingSeriesAdminRepository,
  NumberingSeriesRow,
} from '../domain/ports/numbering-series.repository';
import { NumberingSeriesOrmEntity } from './numbering-series.orm-entity';

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class TypeOrmNumberingSeriesRepository implements NumberingSeriesAdminRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(NumberingSeriesOrmEntity);
  }

  async create(series: NewNumberingSeries): Promise<void> {
    try {
      await this.repo().insert({ ...series, lastSequence: 0 });
    } catch (err) {
      if (
        err instanceof QueryFailedError &&
        (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code ===
          PG_UNIQUE_VIOLATION
      ) {
        throw new SeriesAlreadyExistsError(undefined, {
          companyId: series.companyId,
          financialYearId: series.financialYearId,
          voucherType: series.voucherType,
        });
      }
      throw err;
    }
  }

  async findById(id: string, companyId: string): Promise<NumberingSeriesRow | null> {
    const row = await this.repo().findOne({ where: { id, companyId } });
    return row ? toRow(row) : null;
  }

  async updateConfig(
    id: string,
    companyId: string,
    expectedVersion: number,
    patch: { prefix?: string; paddingWidth?: number },
  ): Promise<boolean> {
    const set: Record<string, unknown> = { updatedAt: () => 'now()', version: () => '"version" + 1' };
    if (patch.prefix !== undefined) set.prefix = patch.prefix;
    if (patch.paddingWidth !== undefined) set.paddingWidth = patch.paddingWidth;
    const result = await this.repo()
      .createQueryBuilder()
      .update(NumberingSeriesOrmEntity)
      .set(set)
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id,
        companyId,
        version: expectedVersion,
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async financialYearBelongsToCompany(
    financialYearId: string,
    companyId: string,
  ): Promise<boolean> {
    const rows: unknown[] = await getManager(this.dataSource).query(
      `SELECT 1 FROM financial_year WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [financialYearId, companyId],
    );
    return rows.length > 0;
  }
}

function toRow(e: NumberingSeriesOrmEntity): NumberingSeriesRow {
  return {
    id: e.id,
    companyId: e.companyId,
    financialYearId: e.financialYearId,
    voucherType: e.voucherType,
    prefix: e.prefix,
    paddingWidth: e.paddingWidth,
    lastSequence: e.lastSequence,
    version: e.version,
  };
}
