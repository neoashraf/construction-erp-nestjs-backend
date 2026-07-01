/**
 * TypeOrmJournalVoucherRepository (INFRASTRUCTURE) — persists the JournalVoucher draft aggregate
 * (JOURNAL + OPENING). Enrols in the active UnitOfWork via getManager; every method companyId-scoped
 * (F3). `existsOpeningFor` backs the one-opening-per-company guard (FR-GEN-012), matched by the DB
 * partial-unique index. Same lock/version/line-rewrite discipline as the contra repository.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { JournalVoucher } from '../domain/journal-voucher';
import { JournalVoucherRepository } from '../domain/ports/journal-voucher.repository';
import { JournalVoucherMapper } from './journal-voucher.mapper';
import { JournalLineDraftOrmEntity, JournalVoucherOrmEntity } from './journal-voucher.orm-entity';

@Injectable()
export class TypeOrmJournalVoucherRepository implements JournalVoucherRepository {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async insert(voucher: JournalVoucher): Promise<void> {
    const m = getManager(this.dataSource);
    const { header, lines } = JournalVoucherMapper.toOrm(voucher);
    header.version = 1;
    await m.getRepository(JournalVoucherOrmEntity).insert(header);
    await this.insertLines(lines);
  }

  async save(voucher: JournalVoucher, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const { header, lines } = JournalVoucherMapper.toOrm(voucher);
    const res = await m
      .getRepository(JournalVoucherOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        voucherDate: header.voucherDate,
        narration: header.narration,
        status: header.status,
        entryNo: header.entryNo,
        journalEntryId: header.journalEntryId,
        postedAt: header.postedAt,
        postedBy: header.postedBy,
        version: expectedVersion + 1,
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: header.id,
        companyId: header.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`JournalVoucher ${header.id} was modified concurrently`, {
        id: header.id,
      });
    }
    await m.getRepository(JournalLineDraftOrmEntity).delete({ journalVoucherId: header.id });
    await this.insertLines(lines);
  }

  async findById(id: string, companyId: string): Promise<JournalVoucher | null> {
    const m = getManager(this.dataSource);
    const header = await m
      .getRepository(JournalVoucherOrmEntity)
      .findOne({ where: { id, companyId, deletedAt: null } as never });
    if (!header) return null;
    const lines = await m.getRepository(JournalLineDraftOrmEntity).find({ where: { journalVoucherId: id } });
    return JournalVoucherMapper.toDomain(header, lines);
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<JournalVoucher | null> {
    const m = getManager(this.dataSource);
    const header = await m
      .getRepository(JournalVoucherOrmEntity)
      .createQueryBuilder('v')
      .setLock('pessimistic_write')
      .where('v.id = :id AND v.company_id = :companyId AND v.deleted_at IS NULL', { id, companyId })
      .getOne();
    if (!header) return null;
    const lines = await m.getRepository(JournalLineDraftOrmEntity).find({ where: { journalVoucherId: id } });
    return JournalVoucherMapper.toDomain(header, lines);
  }

  async softDelete(id: string, companyId: string): Promise<void> {
    const m = getManager(this.dataSource);
    await m
      .getRepository(JournalVoucherOrmEntity)
      .update({ id, companyId } as never, { deletedAt: new Date() });
  }

  async existsOpeningFor(companyId: string): Promise<boolean> {
    const m = getManager(this.dataSource);
    const count = await m
      .getRepository(JournalVoucherOrmEntity)
      .createQueryBuilder('v')
      .where(
        "v.company_id = :companyId AND v.voucher_type = 'OPENING' AND v.deleted_at IS NULL",
        { companyId },
      )
      .getCount();
    return count > 0;
  }

  private async insertLines(lines: JournalLineDraftOrmEntity[]): Promise<void> {
    const m = getManager(this.dataSource);
    for (const line of lines) line.id = this.ids.next();
    if (lines.length) await m.getRepository(JournalLineDraftOrmEntity).insert(lines);
  }
}
