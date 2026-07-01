/**
 * TypeOrmRetentionReleaseRepository (INFRASTRUCTURE) — persists the RetentionRelease aggregate. Enrols in
 * the active UnitOfWork via getManager. Every method is companyId-scoped (F3). `sumPostedReleasedForIpc`
 * backs the retention-held formula (FR-SAL-019): `retentionAmount - Σ released_amount of POSTED releases`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Money } from '../../../common/money';
import { RetentionRelease } from '../domain/retention-release';
import { RetentionReleaseRepository } from '../domain/ports/retention-release.repository';
import { RetentionReleaseMapper } from './retention-release.mapper';
import { RetentionReleaseOrmEntity } from './retention-release.orm-entity';

@Injectable()
export class TypeOrmRetentionReleaseRepository implements RetentionReleaseRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(release: RetentionRelease): Promise<void> {
    const m = getManager(this.dataSource);
    const row = RetentionReleaseMapper.toOrm(release);
    row.version = 1;
    await m.getRepository(RetentionReleaseOrmEntity).insert(row);
  }

  async save(release: RetentionRelease, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const row = RetentionReleaseMapper.toOrm(release);
    const res = await m
      .getRepository(RetentionReleaseOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        releaseDate: row.releaseDate,
        releasedAmount: row.releasedAmount,
        narration: row.narration,
        status: row.status,
        entryNo: row.entryNo,
        journalEntryId: row.journalEntryId,
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
      throw new OptimisticLockConflictError(`Retention release ${row.id} was modified concurrently`, { id: row.id });
    }
  }

  async findById(id: string, companyId: string): Promise<RetentionRelease | null> {
    const row = await getManager(this.dataSource)
      .getRepository(RetentionReleaseOrmEntity)
      .findOne({ where: { id, companyId } });
    return row ? RetentionReleaseMapper.toDomain(row) : null;
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<RetentionRelease | null> {
    const row = await getManager(this.dataSource)
      .getRepository(RetentionReleaseOrmEntity)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.id = :id AND r.company_id = :companyId', { id, companyId })
      .getOne();
    return row ? RetentionReleaseMapper.toDomain(row) : null;
  }

  async listByIpc(ipcId: string, companyId: string): Promise<RetentionRelease[]> {
    const rows = await getManager(this.dataSource)
      .getRepository(RetentionReleaseOrmEntity)
      .find({ where: { ipcId, companyId }, order: { createdAt: 'ASC' } });
    return rows.map((r) => RetentionReleaseMapper.toDomain(r));
  }

  async sumPostedReleasedForIpc(ipcId: string, companyId: string): Promise<Money> {
    const rows: Array<{ total: string | null }> = await getManager(this.dataSource).query(
      `SELECT COALESCE(SUM(released_amount), 0)::text AS total
         FROM retention_release
        WHERE ipc_id = $1 AND company_id = $2 AND status = 'POSTED'`,
      [ipcId, companyId],
    );
    return Money.of(new Decimal(rows[0]?.total ?? '0'));
  }
}
