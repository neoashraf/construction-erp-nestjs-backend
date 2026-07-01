/**
 * TypeOrmIpcRepository (INFRASTRUCTURE) — persists the Ipc aggregate. Enrols in the active UnitOfWork via
 * getManager. Every method is companyId-scoped (F3). `findByIdForUpdate` takes a pessimistic row lock
 * inside the post UoW (anti-double-post, AC8). `save` bumps `version` under the optimistic-lock check.
 * `existsSeqNo` backs the duplicate-IPC-sequence guard (FR-SAL-014); the DB unique index is the backstop.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Ipc } from '../domain/ipc';
import { IpcRepository } from '../domain/ports/ipc.repository';
import { IpcMapper } from './ipc.mapper';
import { IpcOrmEntity } from './ipc.orm-entity';

@Injectable()
export class TypeOrmIpcRepository implements IpcRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(ipc: Ipc): Promise<void> {
    const m = getManager(this.dataSource);
    const row = IpcMapper.toOrm(ipc);
    row.version = 1;
    await m.getRepository(IpcOrmEntity).insert(row);
  }

  async save(ipc: Ipc, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const row = IpcMapper.toOrm(ipc);
    const res = await m
      .getRepository(IpcOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        projectId: row.projectId,
        customerId: row.customerId,
        ipcSeqNo: row.ipcSeqNo,
        ipcDate: row.ipcDate,
        billDate: row.billDate,
        dueDate: row.dueDate,
        workCompletedPct: row.workCompletedPct,
        certifiedAmount: row.certifiedAmount,
        costCentreId: row.costCentreId,
        purposeId: row.purposeId,
        outputVatAmount: row.outputVatAmount,
        aitTdsAmount: row.aitTdsAmount,
        retentionAmount: row.retentionAmount,
        advanceRecoveredAmount: row.advanceRecoveredAmount,
        currentlyDueAmount: row.currentlyDueAmount,
        retentionRatePct: row.retentionRatePct,
        advanceRatePct: row.advanceRatePct,
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
      throw new OptimisticLockConflictError(`IPC ${row.id} was modified concurrently`, { id: row.id });
    }
  }

  async findById(id: string, companyId: string): Promise<Ipc | null> {
    const row = await getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .findOne({ where: { id, companyId, deletedAt: null } as never });
    return row ? IpcMapper.toDomain(row) : null;
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<Ipc | null> {
    const row = await getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .createQueryBuilder('i')
      .setLock('pessimistic_write')
      .where('i.id = :id AND i.company_id = :companyId AND i.deleted_at IS NULL', { id, companyId })
      .getOne();
    return row ? IpcMapper.toDomain(row) : null;
  }

  async existsSeqNo(companyId: string, projectId: string, seqNo: number): Promise<boolean> {
    const count = await getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .count({ where: { companyId, projectId, ipcSeqNo: seqNo, deletedAt: null } as never });
    return count > 0;
  }

  async softDelete(id: string, companyId: string): Promise<void> {
    await getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .update({ id, companyId } as never, { deletedAt: new Date() });
  }
}
