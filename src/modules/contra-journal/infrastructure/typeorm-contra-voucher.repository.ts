/**
 * TypeOrmContraVoucherRepository (INFRASTRUCTURE) — persists the ContraVoucher draft aggregate. Enrols
 * in the active UnitOfWork via getManager. Every method is companyId-scoped (F3). `findByIdForUpdate`
 * takes a pessimistic row lock inside the post UoW (anti-double-post). `save` bumps `version` under the
 * optimistic-lock check and rewrites the line set (delete-and-reinsert of the draft's low-volume lines).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { ContraVoucher } from '../domain/contra-voucher';
import { ContraVoucherRepository } from '../domain/ports/contra-voucher.repository';
import { ContraVoucherMapper } from './contra-voucher.mapper';
import { ContraLineOrmEntity, ContraVoucherOrmEntity } from './contra-voucher.orm-entity';

@Injectable()
export class TypeOrmContraVoucherRepository implements ContraVoucherRepository {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async insert(voucher: ContraVoucher): Promise<void> {
    const m = getManager(this.dataSource);
    const { header, lines } = ContraVoucherMapper.toOrm(voucher);
    header.version = 1;
    await m.getRepository(ContraVoucherOrmEntity).insert(header);
    await this.insertLines(lines);
  }

  async save(voucher: ContraVoucher, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const { header, lines } = ContraVoucherMapper.toOrm(voucher);
    const res = await m
      .getRepository(ContraVoucherOrmEntity)
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
      throw new OptimisticLockConflictError(`ContraVoucher ${header.id} was modified concurrently`, {
        id: header.id,
      });
    }
    await m.getRepository(ContraLineOrmEntity).delete({ contraVoucherId: header.id });
    await this.insertLines(lines);
  }

  async findById(id: string, companyId: string): Promise<ContraVoucher | null> {
    const m = getManager(this.dataSource);
    const header = await m
      .getRepository(ContraVoucherOrmEntity)
      .findOne({ where: { id, companyId, deletedAt: null } as never });
    if (!header) return null;
    const lines = await m.getRepository(ContraLineOrmEntity).find({ where: { contraVoucherId: id } });
    return ContraVoucherMapper.toDomain(header, lines);
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<ContraVoucher | null> {
    const m = getManager(this.dataSource);
    const header = await m
      .getRepository(ContraVoucherOrmEntity)
      .createQueryBuilder('v')
      .setLock('pessimistic_write')
      .where('v.id = :id AND v.company_id = :companyId AND v.deleted_at IS NULL', { id, companyId })
      .getOne();
    if (!header) return null;
    const lines = await m.getRepository(ContraLineOrmEntity).find({ where: { contraVoucherId: id } });
    return ContraVoucherMapper.toDomain(header, lines);
  }

  async softDelete(id: string, companyId: string): Promise<void> {
    const m = getManager(this.dataSource);
    await m
      .getRepository(ContraVoucherOrmEntity)
      .update({ id, companyId } as never, { deletedAt: new Date() });
  }

  private async insertLines(lines: ContraLineOrmEntity[]): Promise<void> {
    const m = getManager(this.dataSource);
    for (const line of lines) line.id = this.ids.next();
    if (lines.length) await m.getRepository(ContraLineOrmEntity).insert(lines);
  }
}
