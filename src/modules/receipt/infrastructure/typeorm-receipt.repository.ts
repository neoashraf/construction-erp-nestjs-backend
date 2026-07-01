/**
 * TypeOrmReceiptRepository (INFRASTRUCTURE) — persists the Receipt aggregate. Enrols in the active
 * UnitOfWork via getManager. Every method is companyId-scoped (F3). `findByIdForUpdate` takes a
 * pessimistic row lock inside the post UoW (anti-double-post, AC8). `save` bumps `version` under the
 * optimistic-lock check.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Receipt } from '../domain/receipt';
import { ReceiptRepository } from '../domain/ports/receipt.repository';
import { ReceiptMapper } from './receipt.mapper';
import { ReceiptOrmEntity } from './receipt.orm-entity';

@Injectable()
export class TypeOrmReceiptRepository implements ReceiptRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(receipt: Receipt): Promise<void> {
    const m = getManager(this.dataSource);
    const row = ReceiptMapper.toOrm(receipt);
    row.version = 1;
    await m.getRepository(ReceiptOrmEntity).insert(row);
  }

  async save(receipt: Receipt, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const row = ReceiptMapper.toOrm(receipt);
    const res = await m
      .getRepository(ReceiptOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        receiptType: row.receiptType,
        receiptDate: row.receiptDate,
        paymentMode: row.paymentMode,
        depositAccountId: row.depositAccountId,
        partyId: row.partyId,
        projectId: row.projectId,
        costCentreId: row.costCentreId,
        purposeId: row.purposeId,
        ipcId: row.ipcId,
        generalTargetAccountId: row.generalTargetAccountId,
        amountSettled: row.amountSettled,
        cashReceived: row.cashReceived,
        taxDeductedAtSource: row.taxDeductedAtSource,
        chequeTxnRef: row.chequeTxnRef,
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
      throw new OptimisticLockConflictError(`Receipt ${row.id} was modified concurrently`, { id: row.id });
    }
  }

  async findById(id: string, companyId: string): Promise<Receipt | null> {
    const row = await getManager(this.dataSource)
      .getRepository(ReceiptOrmEntity)
      .findOne({ where: { id, companyId, deletedAt: null } as never });
    return row ? ReceiptMapper.toDomain(row) : null;
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<Receipt | null> {
    const row = await getManager(this.dataSource)
      .getRepository(ReceiptOrmEntity)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.id = :id AND r.company_id = :companyId AND r.deleted_at IS NULL', { id, companyId })
      .getOne();
    return row ? ReceiptMapper.toDomain(row) : null;
  }

  async softDelete(id: string, companyId: string): Promise<void> {
    await getManager(this.dataSource)
      .getRepository(ReceiptOrmEntity)
      .delete({ id, companyId } as never);
  }
}
