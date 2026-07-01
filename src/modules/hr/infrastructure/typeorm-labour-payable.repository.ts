/**
 * TypeOrmLabourPayableRepository (INFRASTRUCTURE) — persists the LabourPayable rollup. Enrols in the
 * active UnitOfWork via getManager; companyId-scoped (F3). `save` bumps `version` under the optimistic
 * lock. `findByAccrualEntry` lets the PAY-event consumer locate the payable to roll up settlement.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { LabourPayable } from '../domain/labour-payable';
import { LabourPayableRepository } from '../domain/ports/labour-payable.repository';
import { LabourPayableMapper } from './labour-payable.mapper';
import { LabourPayableOrmEntity } from './labour-payable.orm-entity';

@Injectable()
export class TypeOrmLabourPayableRepository implements LabourPayableRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(payable: LabourPayable): Promise<void> {
    const row = LabourPayableMapper.toOrm(payable);
    row.version = 1;
    await getManager(this.dataSource).getRepository(LabourPayableOrmEntity).insert(row);
  }

  async save(payable: LabourPayable, expectedVersion: number): Promise<void> {
    const row = LabourPayableMapper.toOrm(payable);
    const res = await getManager(this.dataSource)
      .getRepository(LabourPayableOrmEntity)
      .createQueryBuilder()
      .update()
      .set({ settledAmount: row.settledAmount, status: row.status, version: expectedVersion + 1 })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: row.id,
        companyId: row.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`LabourPayable ${row.id} was modified concurrently`, { id: row.id });
    }
  }

  async findByAccrualEntry(companyId: string, accrualEntryId: string): Promise<LabourPayable | null> {
    const row = await getManager(this.dataSource)
      .getRepository(LabourPayableOrmEntity)
      .findOne({ where: { companyId, accrualEntryId } as never });
    return row ? LabourPayableMapper.toDomain(row) : null;
  }
}
