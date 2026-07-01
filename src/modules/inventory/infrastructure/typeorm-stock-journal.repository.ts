/**
 * TypeOrmStockJournalRepository (INFRASTRUCTURE) — persists the StockJournal aggregate. Enrols in the
 * active UnitOfWork via getManager; every method companyId-scoped (F3). Same lock/version/line-rewrite
 * discipline as `typeorm-journal-voucher.repository.ts`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { StockJournal } from '../domain/stock-journal';
import { StockJournalRepository } from '../domain/ports/stock-journal.repository';
import { StockJournalMapper } from './stock-journal.mapper';
import { StockJournalLineOrmEntity, StockJournalOrmEntity } from './stock-journal.orm-entity';

@Injectable()
export class TypeOrmStockJournalRepository implements StockJournalRepository {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async insert(journal: StockJournal): Promise<void> {
    const m = getManager(this.dataSource);
    const { header, lines } = StockJournalMapper.toOrm(journal);
    header.version = 1;
    await m.getRepository(StockJournalOrmEntity).insert(header);
    await this.insertLines(lines);
  }

  async save(journal: StockJournal, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const { header, lines } = StockJournalMapper.toOrm(journal);
    const res = await m
      .getRepository(StockJournalOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        entryNo: header.entryNo,
        voucherDate: header.voucherDate,
        mode: header.mode,
        status: header.status,
        fromGodownId: header.fromGodownId,
        toGodownId: header.toGodownId,
        itemId: header.itemId,
        quantity: header.quantity,
        rate: header.rate,
        value: header.value,
        projectId: header.projectId,
        costCentreId: header.costCentreId,
        purposeId: header.purposeId,
        issuedById: header.issuedById,
        receivedById: header.receivedById,
        approvedById: header.approvedById,
        approvedAt: header.approvedAt,
        allowNegativeStock: header.allowNegativeStock,
        negativeStockAuthorisedById: header.negativeStockAuthorisedById,
        negativeStockReason: header.negativeStockReason,
        journalEntryId: header.journalEntryId,
        narration: header.narration,
        postedAt: header.postedAt,
        postedById: header.postedById,
        version: expectedVersion + 1,
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: header.id,
        companyId: header.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`StockJournal ${header.id} was modified concurrently`, {
        id: header.id,
      });
    }
    await m.getRepository(StockJournalLineOrmEntity).delete({ stockJournalId: header.id });
    await this.insertLines(lines);
  }

  async findById(id: string, companyId: string): Promise<StockJournal | null> {
    const m = getManager(this.dataSource);
    const header = await m
      .getRepository(StockJournalOrmEntity)
      .findOne({ where: { id, companyId, deletedAt: null } as never });
    if (!header) return null;
    const lines = await m
      .getRepository(StockJournalLineOrmEntity)
      .find({ where: { stockJournalId: id } });
    return StockJournalMapper.toDomain(header, lines);
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<StockJournal | null> {
    const m = getManager(this.dataSource);
    const header = await m
      .getRepository(StockJournalOrmEntity)
      .createQueryBuilder('v')
      .setLock('pessimistic_write')
      .where('v.id = :id AND v.company_id = :companyId AND v.deleted_at IS NULL', { id, companyId })
      .getOne();
    if (!header) return null;
    const lines = await m
      .getRepository(StockJournalLineOrmEntity)
      .find({ where: { stockJournalId: id } });
    return StockJournalMapper.toDomain(header, lines);
  }

  async softDelete(id: string, companyId: string): Promise<void> {
    const m = getManager(this.dataSource);
    await m
      .getRepository(StockJournalOrmEntity)
      .update({ id, companyId } as never, { deletedAt: new Date() });
  }

  private async insertLines(lines: StockJournalLineOrmEntity[]): Promise<void> {
    const m = getManager(this.dataSource);
    for (const line of lines) line.id = this.ids.next();
    if (lines.length) await m.getRepository(StockJournalLineOrmEntity).insert(lines);
  }
}
